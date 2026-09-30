/**
 * 入站管线（T19/T20/T21 + T22–T25 + 阶段 4 三门 T28/T29/T35）：
 *
 * 1. extractContent → 支持集之外（audio 之外的音乐类 / video_note / …）静默完成，零副作用
 * 2. from 校验（缺 id → 静默完成）
 * 3. ensureUser → { isNew, displayChanged, firstSeenAt } + 治理快照
 *    （isBanned / isVerified / verifyAnswer / verifyMsgId）
 * ①封禁门 isBanned → 拦截 + claimNoticeSlot 赢得才发 BAN_NOTICE（T30 频控）；
 *    封禁用户零验证 / 限频逻辑、零 topic 副作用、零账本
 * ②验证门 !isVerified → 欢迎语（isNew / isStart，slot 门控——阶段 3 语义）+
 *    验证题（首联包 isNew 不占 slot 与欢迎成对；存量 / pending 重出 slot
 *    门控——赢才出换题防死锁，输静默）；本条丢弃（/start 亦如此）
 * ③限频门 countMessageInWindow 超限 → markUnverified + 置顶降级 ❌（best-effort）
 *    + slot 赢得才发「含限频数字 + 新题 + 按钮」合并消息（单 push）；本条丢弃
 * ④通过三门 → 阶段 3 链原样：
 *    topic 解析（open 复用 / closed 重开 / 新建 + 竞态清理）
 *      4a. pinned_msg_id === null → 发用户信息并置顶（验证行恒 ✅——三门后必已验证）
 *      4b. pinned 且 displayChanged → editMessageText 刷新（best-effort）
 *    欢迎语（仅 isStart 可达：新用户一律先落验证门；slot 门控）
 *    /start 短路（入口命令非对话内容，不中继不写账本）
 *    中继 relayContent → 账本 insertMessage
 *
 * 门序固定：封禁 → 验证 → 限频（封禁不消耗验证 / 限频逻辑；未验证消息不进
 * 限频计数）。三门在建档之后、topic 之前；被任一门拦截 = 零 topic 副作用、
 * 零账本，按成功处理（webhook markProcessed + 200，不积压补发——答题前被
 * 丢弃的消息不回溯，T28）。
 *
 * 逐步失败语义（design.md §四 + 阶段 3 表格，binding）：
 * | 步骤                | retryable                    | permanent                          |
 * | ①禁言提示            | 抛（slot 已耗，宁丢一条）      | warn 吞                            |
 * | ②欢迎语 / 验证题      | 抛（同上——重推出题，旧题失效） | warn 吞（题不落库）                 |
 * | ③置顶降级            | warn 跳过（best-effort）      | 同左                               |
 * | ③超限合并消息         | 抛（slot 已耗）               | warn 吞（题不落库）                 |
 * | 4a 置顶 send         | 抛（重推重走 4a，不重建 topic）| warn 跳过，**不写** pinned_msg_id |
 * | 4a pin              | 抛（同上）                    | warn，信息消息已在，**仍写**       |
 * | 4b 刷新置顶          | warn 跳过（best-effort）      | 同左                               |
 * | ④欢迎语（start 载体） | 抛（slot 已占，可能丢失）      | warn 跳过                          |
 * | ④中继               | 抛（→ 重推）                  | warn 跳过=丢弃，**不写账本**       |
 * | ④账本               | 抛（→ 重推；可能重发一次中继） | —（D1 错误统一按 retryable 抛）    |
 *
 * ③的置顶降级排在合并消息之前且 best-effort：撤验证后重推只会落回验证门
 * （②），永远不会再走到③——降级必须在本轮完成，失败也不抛断主流程。
 */
import { BAN_NOTICE, DEFAULT_WELCOME_TEXT, formatPinnedInfo, isStartCommand } from "../copy";
import { parseMaxMessagesPerMinute, parseSupportChatId, parseWelcomeText } from "../env";
import { insertMessage } from "../store/messages";
import {
  findTopicByUser,
  insertTopic,
  isUniqueViolation,
  reopenTopic,
  setPinnedMsgId,
  type TopicRow,
} from "../store/topics";
import {
  claimNoticeSlot,
  countMessageInWindow,
  ensureUser,
  markUnverified,
} from "../store/users";
import { createTelegramClient } from "../telegram/client";
import type { TelegramClient } from "../telegram/types";
import { sendVerificationCode } from "./verify";
import { extractContent, relayContent } from "./content";
import type { TelegramMessageRef } from "./classify";

/** title 三级回退（建档时定死，不再复算）：first_name → @username → ID_<user_id> */
function resolveTopicTitle(from: { id: number; first_name?: string; username?: string }): string {
  const firstName = from.first_name?.trim();
  if (firstName) return firstName;
  if (from.username) return `@${from.username}`;
  return `ID_${from.id}`;
}

/**
 * 欢迎语（T23，claimNoticeSlot 原子频控；T30 起与其他提示共享 slot）。
 * 验证门（首联 / 未验证 start）与阶段 3 链（已验证 start）共用同一语义：
 * retryable → 抛（slot 已被占：重推不再补发，宁可丢失也不重复轰炸）；
 * permanent → warn 跳过。
 */
async function maybeSendWelcome(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  userId: number,
): Promise<void> {
  if (!(await claimNoticeSlot(env.HODOR_DB, botId, userId))) return;
  // 文案可用环境变量 WELCOME_TEXT 覆盖（字面 \n 解释为换行），未配置兜底默认
  const welcomeText = parseWelcomeText(env) ?? DEFAULT_WELCOME_TEXT;
  const welcome = await client.sendMessage({ chat_id: userId, text: welcomeText });
  if (!welcome.ok) {
    if (welcome.kind === "retryable") {
      throw new Error(welcome.errorMessage ?? "sendMessage retryable");
    }
    console.warn(
      `[inbound] user ${userId}: 欢迎语 permanent，跳过：${welcome.errorMessage ?? "no detail"}`,
    );
  }
}

/**
 * 处理一条私聊 message：建档 → 三门（封禁 / 验证 / 限频）→ 阶段 3 链
 * （topic+置顶 → 欢迎语 → 中继 → 账本）。
 * 完成（resolve）= 按成功处理；抛出（reject）= retryable，交 webhook 500 重推。
 */
export async function handleInbound(
  env: Cloudflare.Env,
  botId: number,
  message: TelegramMessageRef,
): Promise<void> {
  // 防御：classify 已对 supportChatId===null fail-closed，正常到不了这里；
  // 真到了说明部署配置坏了——按 retryable 处理让 5xx 暴露问题
  const supportChatId = parseSupportChatId(env);
  if (supportChatId === null) throw new Error("inbound: SUPPORT_CHAT_ID 无效");

  // 1. 支持集之外 / 畸形内容 → 静默完成（先于一切副作用：不建档、不建 topic）
  const payload = extractContent(message);
  if (payload === null) return;
  // 2. 私聊 message 必带 from；缺 from 视为畸形信封，静默完成零副作用
  const from = message.from;
  if (!from || typeof from.id !== "number") return;

  // 3. 建档 / 刷新（治理列不动；快照驱动三门；firstSeenAt 供置顶信息）
  const userState = await ensureUser(env.HODOR_DB, botId, from);

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const isStart = payload.type === "text" ? isStartCommand(payload.text) : false;

  /* ---------------- ① 封禁门（T35）：banned → 拦截 + 频控禁言提示 ---------------- */
  if (userState.isBanned) {
    if (await claimNoticeSlot(env.HODOR_DB, botId, from.id)) {
      const notice = await client.sendMessage({ chat_id: from.id, text: BAN_NOTICE });
      if (!notice.ok) {
        if (notice.kind === "retryable") {
          // slot 已被占：重推不再补发（宁丢一条提示，绝不轰炸）
          throw new Error(notice.errorMessage ?? "sendMessage retryable");
        }
        console.warn(
          `[inbound] user ${from.id}: 禁言提示 permanent，跳过：${notice.errorMessage ?? "no detail"}`,
        );
      }
    }
    return;
  }

  /* ---------------- ② 验证门（T27/T28）：未验证 → 欢迎语 + 验证题，本条丢弃 ---------------- */
  if (!userState.isVerified) {
    // 欢迎语：isNew（首联包前半）或 isStart —— 阶段 3 语义不变（slot 门控）
    if (userState.isNew || isStart) {
      await maybeSendWelcome(env, client, botId, from.id);
    }
    // 出题策略：isNew 首联包不占 slot（与欢迎语成对发出）；存量未验证（无题 /
    // 有 pending）一律 slot 门控重出**新题**——赢才出（重发节流，T30），输静默
    if (userState.isNew || (await claimNoticeSlot(env.HODOR_DB, botId, from.id))) {
      await sendVerificationCode(env, botId, from.id, { type: "question" });
    }
    // 丢弃：不建 topic、不置顶、不中继、不写账本（/start 亦如此）；被丢弃的
    // 消息不积压补发——通过验证后的新消息才进入正常管线
    return;
  }

  /* ---------------- ③ 限频门（T29）：固定窗口，超限 → 撤验证重验，本条丢弃 ---------------- */
  const limit = parseMaxMessagesPerMinute(env);
  if (!(await countMessageInWindow(env.HODOR_DB, botId, from.id, limit))) {
    await markUnverified(env.HODOR_DB, botId, from.id);
    // 置顶降级 ❌（best-effort，两种失败都 warn）：撤验证后重推只会落回验证门，
    // 不会再走到本门——降级必须本轮完成；无 topic / 未置顶则跳过
    const topic = await findTopicByUser(env.HODOR_DB, botId, from.id);
    if (topic && topic.pinned_msg_id !== null) {
      const downgraded = await client.editMessageText({
        chat_id: supportChatId,
        message_id: topic.pinned_msg_id,
        text: formatPinnedInfo({
          id: from.id,
          first_name: from.first_name,
          last_name: from.last_name,
          username: from.username,
          firstSeenAt: userState.firstSeenAt,
          isVerified: false,
        }),
      });
      if (!downgraded.ok) {
        console.warn(
          `[inbound] user ${from.id}: 置顶降级 ❌ 未验证失败（best-effort 跳过）：${downgraded.errorMessage ?? "no detail"}`,
        );
      }
    }
    // 合并消息（提示含 limit 数字 + 新题 + 按钮，单 push）——slot 赢得才发，
    // 输则静默（持续刷消息不产生持续回复；重验入口由 60s 后的下一条消息提供）
    if (await claimNoticeSlot(env.HODOR_DB, botId, from.id)) {
      await sendVerificationCode(env, botId, from.id, { type: "overflow", limit });
    }
    return;
  }

  /* ---------------- ④ 阶段 3 链（三门全过；以下逻辑不变） ---------------- */
  const topic = await resolveTopic(env, client, {
    botId,
    userId: from.id,
    supportChatId,
    title: resolveTopicTitle(from),
  });
  // null = createForumTopic permanent（topic 未建），本条按已处理丢弃（阶段 2 语义）
  if (topic === null) return;

  /** 置顶信息正文（昵称用本次消息的最新展示字段 + 库内建档时间） */
  const pinnedText = () =>
    formatPinnedInfo({
      id: from.id,
      first_name: from.first_name,
      last_name: from.last_name,
      username: from.username,
      firstSeenAt: userState.firstSeenAt,
      // 验证门已过——新置顶的验证行恒为真值 ✅（存量置顶由答题 / 降级路径刷新）
      isVerified: true,
    });

  /* ---------------- 4a / 4b：用户信息置顶（T24） ---------------- */
  if (topic.pinned_msg_id === null) {
    await pinUserCard(env, client, {
      botId,
      userId: from.id,
      supportChatId,
      threadId: topic.thread_id,
      text: pinnedText(),
    });
  } else if (userState.displayChanged) {
    // 4b 昵称变更刷新：best-effort——两种失败都只 warn，下次变更再试
    const edited = await client.editMessageText({
      chat_id: supportChatId,
      message_id: topic.pinned_msg_id,
      text: pinnedText(),
    });
    if (!edited.ok) {
      console.warn(
        `[inbound] user ${from.id}: 置顶信息刷新失败（best-effort 跳过）：${edited.errorMessage ?? "no detail"}`,
      );
    }
  }

  /* ---------------- 5. 欢迎语（T23；仅 isStart 可达——新用户一律先落验证门） ---------------- */
  if (isStart) {
    await maybeSendWelcome(env, client, botId, from.id);
  }

  /* ---------------- 6. 中继（/start 短路；其余 per-type send 干净渲染） ---------------- */
  // isStartCommand 命中的所有变体（/start、/start@bot、/start payload）是纯入口 /
  // 控制命令而非对话内容：新 topic 出现 + 置顶即首联信号，不把 start 文本刷进
  // topic（2026-09-30 真机验收修正）；payload 变体 v1 无深链场景，一并跳过。
  // 短路 = 静默完成（update 照常 processed），中继与账本（第 7 步）都不执行。
  if (isStart) return;

  const relayed = await relayContent(client, payload, {
    chatId: supportChatId,
    threadId: topic.thread_id,
  });
  if (!relayed.ok) {
    if (relayed.kind === "retryable") {
      throw new Error(relayed.errorMessage ?? "relay retryable");
    }
    // permanent：重试无益，消息被丢弃——**不写账本**（T25 只记成功中继）
    console.warn(
      `[inbound] user ${from.id}: 中继 permanent，按已处理跳过（消息被丢弃，不写账本）：${relayed.errorMessage ?? "no detail"}`,
    );
    return;
  }

  /* ---------------- 7. 账本（T25；失败原样抛 → 重推可能重发一次中继） ---------------- */
  await insertMessage(env.HODOR_DB, {
    botId,
    userId: from.id,
    threadId: topic.thread_id,
    direction: "in",
    groupMsgId: relayed.result.message_id,
    privateMsgId: message.message_id,
    contentType: payload.type,
  });
}

/** 竞态清理的上下文（createTopic 主流程 + 失败路径共用） */
interface CreateTopicContext {
  botId: number;
  userId: number;
  supportChatId: number;
  title: string;
}

/**
 * topic 解析（阶段 2 逻辑不变，返回值扩为整行——置顶流程需要 pinned_msg_id）：
 * open 复用 / closed 重开（pinned_msg_id 保留，重开不重发置顶）/ 未命中走建 topic
 * 主流程（含并发首联竞态的败方清理）。
 */
async function resolveTopic(
  env: Cloudflare.Env,
  client: TelegramClient,
  ctx: CreateTopicContext,
): Promise<TopicRow | null> {
  const existing = await findTopicByUser(env.HODOR_DB, ctx.botId, ctx.userId);
  if (existing && existing.status === "open") return existing;
  if (existing) {
    // closed：终身一个 topic，重开复用（阶段 6 预留语义）
    await reopenTopic(env.HODOR_DB, ctx.botId, ctx.userId);
    return existing;
  }
  return createTopicWithRaceCleanup(env, client, ctx);
}

/** 4a 置顶流程的上下文 */
interface PinUserCardContext {
  botId: number;
  userId: number;
  supportChatId: number;
  threadId: number;
  text: string;
}

/**
 * 4a：在 topic 内发用户信息消息并置顶、落库（T24「每 topic 恰一条」的唯一入口）。
 *
 * - 信息 send retryable → 抛（重推重走 4a：topic 已在、pinned_msg_id 仍 null，
 *   不重建 topic、不重发用户消息；极端窗口可能遗留一条未置顶的旧信息消息，
 *   接受并记录日志——design.md §四）
 * - 信息 send permanent → warn 跳过，**不写** pinned_msg_id（后续消息可再尝试）
 * - pin permanent → warn，信息消息已在，**仍写** pinned_msg_id（供 4b edit 刷新）
 */
async function pinUserCard(
  env: Cloudflare.Env,
  client: TelegramClient,
  ctx: PinUserCardContext,
): Promise<void> {
  const sent = await client.sendMessage({
    chat_id: ctx.supportChatId,
    text: ctx.text,
    message_thread_id: ctx.threadId,
  });
  if (!sent.ok) {
    if (sent.kind === "retryable") throw new Error(sent.errorMessage ?? "sendMessage retryable");
    console.warn(
      `[inbound] user ${ctx.userId}: 置顶信息发送 permanent，跳过置顶（不落 pinned_msg_id）：${sent.errorMessage ?? "no detail"}`,
    );
    return;
  }
  const pinnedMsgId = sent.result.message_id;

  const pinned = await client.pinChatMessage({
    chat_id: ctx.supportChatId,
    message_id: pinnedMsgId,
  });
  if (!pinned.ok) {
    if (pinned.kind === "retryable") throw new Error(pinned.errorMessage ?? "pinChatMessage retryable");
    console.warn(
      `[inbound] user ${ctx.userId}: pinChatMessage permanent（信息消息已在，仍记录 pinned_msg_id 供刷新）：${pinned.errorMessage ?? "no detail"}`,
    );
  }
  // 落库：D1 失败原样抛（→ retryable 重推；重推重走 4a 属已接受的极端窗口）
  await setPinnedMsgId(env.HODOR_DB, ctx.botId, ctx.userId, pinnedMsgId);
}

/** 未命中映射时的建 topic 主流程失败语义（阶段 2 不变） */
async function createTopicWithRaceCleanup(
  env: Cloudflare.Env,
  client: TelegramClient,
  ctx: CreateTopicContext,
): Promise<TopicRow | null> {
  const created = await client.createForumTopic({
    chat_id: ctx.supportChatId,
    name: ctx.title,
  });
  if (!created.ok) {
    if (created.kind === "retryable") {
      throw new Error(created.errorMessage ?? "createForumTopic retryable");
    }
    // permanent：无 topic 可用，本条消息按已处理丢弃（阶段 2 语义，不 5xx）
    console.warn(
      `[inbound] user ${ctx.userId}: createForumTopic permanent，topic 未建、消息被丢弃：${created.errorMessage ?? "no detail"}`,
    );
    return null;
  }
  const newThreadId = created.result.message_thread_id;

  try {
    await insertTopic(env.HODOR_DB, {
      botId: ctx.botId,
      userId: ctx.userId,
      threadId: newThreadId,
      title: ctx.title,
    });
    // 新建行 pinned_msg_id 必为 null（由 4a 判定驱动置顶）
    return { thread_id: newThreadId, title: ctx.title, status: "open", pinned_msg_id: null };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // 竞态败方：胜方已写入映射，清掉自己刚建的群 topic
    console.warn(
      `[inbound] user ${ctx.userId}: topic 映射竞态，败方清理 thread ${newThreadId}`,
    );
    const deleted = await client.deleteForumTopic({
      chat_id: ctx.supportChatId,
      message_thread_id: newThreadId,
    });
    if (!deleted.ok) {
      console.warn(
        `[inbound] user ${ctx.userId}: 败方 deleteForumTopic(${newThreadId}) 未成功（孤儿 topic 交人工清理）：${deleted.errorMessage ?? "no detail"}`,
      );
    }

    const winner: TopicRow | null = await findTopicByUser(env.HODOR_DB, ctx.botId, ctx.userId);
    if (!winner) {
      // 唯一冲突却查无胜方行（如 (bot_id,thread_id) 撞上他行）：交给重推重建
      throw new Error("inbound: topic 竞态清理后仍未取得映射行");
    }
    // 胜方行的 pinned_msg_id 原样返回（胜方可能已置顶——不重复置顶）
    return winner;
  }
}
