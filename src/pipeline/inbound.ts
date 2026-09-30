/**
 * 入站管线（T19/T20/T21 + T22/T23/T24/T25，design.md「入站管线」canonical order）：
 *
 * 1. extractContent → 支持集之外（audio / video_note / …）静默完成，零副作用
 * 2. from 校验（缺 id → 静默完成）
 * 3. ensureUser → { isNew, displayChanged, firstSeenAt }
 * 4. topic 解析（阶段 2 逻辑不变：open 复用 / closed 重开 / 新建 + 竞态清理）
 *    4a. pinned_msg_id === null（新 topic 或上次置顶未落库）→ 发用户信息并置顶
 *    4b. pinned 且 displayChanged → editMessageText 刷新（best-effort）
 * 5. 欢迎语：isNew 或 isStartCommand → claimNoticeSlot 赢得才发（每用户每分钟 1 次）
 * 6. 中继：relayContent（text → sendMessage；媒体 → per-type send 按 file_id 直传）；
 *    isStartCommand 命中的 /start 变体在本步前**短路**——入口命令非对话内容，
 *    不中继、不写账本（新 topic 出现 + 置顶即首联信号；2026-09-30 真机验收修正）
 * 7. 账本：中继 ok → insertMessage(direction 'in', private=用户原始, group=中继结果)
 *
 * 顺序动机：置顶 / 欢迎语都排在中继**之前**——它们的 retryable 失败抛出后重推，
 * 中继尚未发生，不会造成用户消息重复；把重复发送窗口压缩到只剩「中继成功后
 * 账本写失败」一处（阶段 2 定稿的 at-least-once 代价，绝不提前标记 processed 掩盖）。
 *
 * 逐步失败语义（design.md §二表格，binding）：
 * | 步骤           | retryable                    | permanent                          |
 * | 4a 置顶 send   | 抛（重推重走 4a，不重建 topic）| warn 跳过，**不写** pinned_msg_id |
 * | 4a pin         | 抛（同上；极端窗口遗留未置顶  | warn，信息消息已在，**仍写**       |
 * |                |  的旧信息消息，接受并记日志）  | pinned_msg_id 供后续 edit 刷新     |
 * | 4b 刷新置顶    | warn 跳过（best-effort）      | 同左                               |
 * | 5 欢迎语       | 抛（slot 已占，欢迎语可能丢失，| warn 跳过                          |
 * |                |  60s 后再 start 可再触发）     |                                    |
 * | 6 中继         | 抛（→ 重推；部分成功窗口=阶段2）| warn 跳过=丢弃，**不写账本**       |
 * | 7 账本         | 抛（→ 重推；可能重发一次中继） | —（D1 错误统一按 retryable 抛）    |
 *
 * topic 建立 permanent 失败沿用阶段 2 语义：本条按已处理丢弃（不欢迎、不中继）。
 */
import { DEFAULT_WELCOME_TEXT, formatPinnedInfo, isStartCommand } from "../copy";
import { parseSupportChatId, parseWelcomeText } from "../env";
import { insertMessage } from "../store/messages";
import {
  findTopicByUser,
  insertTopic,
  isUniqueViolation,
  reopenTopic,
  setPinnedMsgId,
  type TopicRow,
} from "../store/topics";
import { claimNoticeSlot, ensureUser } from "../store/users";
import { createTelegramClient } from "../telegram/client";
import type { TelegramClient } from "../telegram/types";
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
 * 处理一条私聊 message：建档 → 确保 topic（+置顶）→ 欢迎语（频控）→ 中继 → 账本。
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

  // 3. 建档 / 刷新（治理列不动；firstSeenAt 供置顶信息）
  const userState = await ensureUser(env.HODOR_DB, botId, from);

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  /* ---------------- 4. topic 解析（阶段 2 逻辑不变） ---------------- */
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

  /* ---------------- 5. 欢迎语（T23，claimNoticeSlot 原子频控） ---------------- */
  const isStart = payload.type === "text" ? isStartCommand(payload.text) : false;
  if (userState.isNew || isStart) {
    if (await claimNoticeSlot(env.HODOR_DB, botId, from.id)) {
      // 文案可用环境变量 WELCOME_TEXT 覆盖（字面 \n 解释为换行），未配置兜底默认
      const welcomeText = parseWelcomeText(env) ?? DEFAULT_WELCOME_TEXT;
      const welcome = await client.sendMessage({ chat_id: from.id, text: welcomeText });
      if (!welcome.ok) {
        if (welcome.kind === "retryable") {
          // slot 已被占：重推不再补发（欢迎语可能丢失，60s 后再 start 可再触发；
          // 宁可丢失也不重复轰炸）
          throw new Error(welcome.errorMessage ?? "sendMessage retryable");
        }
        console.warn(
          `[inbound] user ${from.id}: 欢迎语 permanent，跳过：${welcome.errorMessage ?? "no detail"}`,
        );
      }
    }
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
