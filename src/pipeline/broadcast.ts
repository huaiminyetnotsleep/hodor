/**
 * 全用户广播管线（2026-10-09 任务，design.md §三–§七）：
 *
 * - handleBroadcastCommand：classify=broadcast（客服群 General 的 /broadcast）
 *   派发入口——鉴权 → 解析 → getMe 落款 → 组装/校验 → 建 preparing 行 →
 *   General 发送 HTML 公告预览 → 回复控制消息（确认/取消按钮）→ pending。
 * - handleBroadcastCallback：`b:y|n:<id>` 按钮处理——多重核对 → 原子裁决 →
 *   确认胜出后在**同一回调请求内**顺序逐位私聊发送（与 /wipealldata 请求内
 *   循环同一既有模式；零 Cron / Queues / 后台执行器）。
 *
 * 三态消费（error-handling spec）：
 * - 发起/终态收尾的 Telegram 调用 retryable → 抛（webhook 500 重推，重跑按
 *   D1 状态幂等续做或修复）；permanent → warn + 补偿文案 + 终止。
 * - 确认胜出后的一切副作用（toast / 「正在发送…」编辑）一律 best-effort——
 *   抛出会让已冻结的任务停在半路，绝不因展示面失败丢整批。
 * - 发送循环三态按 design §7.3：ok → 成功；permanent（含 403 屏蔽）→ 失败
 *   继续；retryable 且带 retry_after → 有界 sleep（≤10s）后重试恰一次，仍
 *   失败计失败继续；其他最终 retryable → 失败继续。绝不循环重试。
 *
 * 非原子窗口（design §7.1/§7.4，均有测试固化）：Telegram 发送与 D1 落库不能
 * 原子提交——预览/控制消息发出后落库失败按 §7.1 补偿；极端双重故障留下的
 * 孤立草稿不持有可执行任务（按钮严格匹配库存 control_msg_id）。
 */
import {
  BROADCAST_CANCELLED_TEXT,
  BROADCAST_CANCEL_LABEL,
  BROADCAST_CONFIRM_LABEL,
  BROADCAST_CONTROL_CREATE_FAILED_NOTICE,
  BROADCAST_DRAFT_EXISTS_NOTICE,
  BROADCAST_EMPTY_RECIPIENTS_NOTICE,
  BROADCAST_EXPIRED_TEXT,
  BROADCAST_FALLBACK_SIGNATURE,
  BROADCAST_GETME_FAILED_NOTICE,
  BROADCAST_INTERRUPTED_TEXT,
  BROADCAST_NOT_ADMIN_NOTICE,
  BROADCAST_NO_RECIPIENTS_TEXT,
  BROADCAST_PREVIEW_CREATE_FAILED_NOTICE,
  BROADCAST_SENDING_TEXT,
  BROADCAST_TOAST_ALREADY_HANDLED,
  BROADCAST_TOAST_BUSY,
  BROADCAST_TOAST_CANCELLED,
  BROADCAST_TOAST_CONFIRMED,
  BROADCAST_TOAST_DONE,
  BROADCAST_TOAST_EXPIRED,
  BROADCAST_TOAST_NOT_ADMIN,
  BROADCAST_TOAST_NOT_INITIATOR,
  BROADCAST_TOAST_SENDING,
  BROADCAST_USAGE_NOTICE,
  formatBroadcastControlText,
  formatBroadcastDoneText,
  formatBroadcastTooLong,
  formatBroadcastTooManyRecipients,
} from "../copy";
import { parseAdminIds, parseSupportChatId } from "../env";
import {
  BROADCAST_MAX_VISIBLE_LENGTH,
  composeBroadcast,
  parseBroadcastInput,
} from "./broadcastFormat";
import {
  BROADCAST_PREVIEW_TTL_MS,
  BROADCAST_RECIPIENT_LIMIT,
  cancelBroadcast,
  cleanupStaleBroadcasts,
  completeBroadcast,
  confirmBroadcast,
  countEligibleRecipients,
  decodeRecipientIds,
  deleteBroadcast,
  expireBroadcast,
  findActiveDraft,
  findBroadcastById,
  findBroadcastBySourceUpdate,
  insertPreparingBroadcast,
  isBroadcastSending,
  listEligibleRecipients,
  setBroadcastPendingWithControlMsgId,
  setBroadcastPreviewMsgId,
  type BroadcastRow,
} from "../store/broadcasts";
import { upsertBot } from "../store/bots";
import { createTelegramClient } from "../telegram/client";
import type { InlineKeyboardMarkup, TelegramClient } from "../telegram/types";
import type { TelegramCallbackQueryRef, TelegramMessageRef } from "./classify";

/** 预览有效期分钟数（控制消息文案展示用；与 BROADCAST_PREVIEW_TTL_MS 同源） */
const BROADCAST_PREVIEW_TTL_MINUTES = BROADCAST_PREVIEW_TTL_MS / 60_000;

/** 发送循环内 429 有界等待上限（秒；design §7.3：≤10s、恰一次） */
const BROADCAST_RETRY_SLEEP_MAX_SECONDS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Telegram 消费辅助                                                    */
/* ------------------------------------------------------------------ */

/**
 * General 文本反馈（发起阶段）：retryable → 抛（重推幂等续做）；permanent →
 * warn 吞（commands.ts replyInGeneral 同姿态）。
 */
async function sendGeneralText(
  client: TelegramClient,
  chatId: number,
  text: string,
): Promise<void> {
  const sent = await client.sendMessage({ chat_id: chatId, text });
  if (!sent.ok) {
    if (sent.kind === "retryable") throw new Error(sent.errorMessage ?? "sendMessage retryable");
    console.warn(`[broadcast] General 反馈 permanent，跳过：${sent.errorMessage ?? "no detail"}`);
  }
}

/** 补偿提示（非原子窗口的尽力告知）：任何失败都只 warn，绝不掩盖原始错误 */
async function replyGeneralBestEffort(
  client: TelegramClient,
  chatId: number,
  text: string,
): Promise<void> {
  try {
    await client.sendMessage({ chat_id: chatId, text });
  } catch (error) {
    console.warn(`[broadcast] 补偿提示发送失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** toast（answerCallbackQuery）：广播管线的 toast 全部 best-effort——DB 状态机
 *  才是行为依据，展示面失败绝不改变流程（确认胜出后抛 toast 会丢整批发送） */
async function answerBestEffort(
  client: TelegramClient,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  const answered = await client.answerCallbackQuery({ callbackQueryId, text });
  if (!answered.ok) {
    console.warn(
      `[broadcast] callback ${callbackQueryId}: answerCallbackQuery 失败，跳过：${answered.errorMessage ?? "no detail"}`,
    );
  }
}

/** 发送中 / 终态控制消息去除确认键盘；editMessageText 不附 reply_markup 会保留旧键盘 */
const EMPTY_BROADCAST_KEYBOARD: InlineKeyboardMarkup = { inline_keyboard: [] };

/**
 * 惰性清理后的展示收尾（design §7.1 / §7.2）：过期草稿与中断任务在任何
 * 广播命令 / callback 触发清理时都要同步更新 General 控制消息并删终态行。
 * 展示编辑完全 best-effort（retryable/permanent 均 warn 吞），不阻断新操作；
 * preparing 没有 control_msg_id 时删行，已发预览作为不持有任务的孤立历史保留。
 */
async function cleanupStaleAndFinalize(
  db: D1Database,
  client: TelegramClient,
  botId: number,
): Promise<void> {
  const staleRows = await cleanupStaleBroadcasts(db, botId);
  for (const row of staleRows) {
    if (row.control_msg_id !== null) {
      const text = row.status === "expired" ? BROADCAST_EXPIRED_TEXT : BROADCAST_INTERRUPTED_TEXT;
      const edited = await client.editMessageText({
        chat_id: row.support_chat_id,
        message_id: row.control_msg_id,
        text,
        reply_markup: EMPTY_BROADCAST_KEYBOARD,
      });
      if (!edited.ok) {
        console.warn(
          `[broadcast] 陈旧任务控制消息收尾失败（继续）：${edited.errorMessage ?? "no detail"}`,
        );
      }
    }
    await deleteBroadcast(db, botId, row.id);
  }
}

/** 确认 / 取消按钮键盘（callback_data 短载荷，远低于 64-byte 上限） */
function buildBroadcastKeyboard(broadcastId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: BROADCAST_CONFIRM_LABEL, callback_data: `b:y:${broadcastId}` },
        { text: BROADCAST_CANCEL_LABEL, callback_data: `b:n:${broadcastId}` },
      ],
    ],
  };
}

/** 解析按钮载荷：`b:y|n:<正整数ID>`（与 buildBroadcastKeyboard 同构）→ { confirm, id }；其余 null */
function parseCallbackData(data: string): { confirm: boolean; id: number } | null {
  const match = data.match(/^b:(y|n):(\d{1,10})$/);
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { confirm: match[1] === "y", id };
}

/* ------------------------------------------------------------------ */
/* 发起：General /broadcast 命令 → 预览 + 控制消息                      */
/* ------------------------------------------------------------------ */

/** 处理客服群 General 的 /broadcast（webhook classify=broadcast 派发） */
export async function handleBroadcastCommand(
  env: Cloudflare.Env,
  botId: number,
  updateId: number,
  message: TelegramMessageRef,
): Promise<void> {
  const supportChatId = parseSupportChatId(env);
  // classify 已保证 chat = 客服群 General；双保险（env 畸形 fail-closed）
  if (supportChatId === null || message.chat.id !== supportChatId) return;
  const from = message.from;
  if (!from || typeof from.id !== "number") return;
  const chatId = message.chat.id;

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  // 管理员鉴权（R7）：非管理员不能创建记录、预览或按钮
  if (!parseAdminIds(env).includes(from.id)) {
    await sendGeneralText(client, chatId, BROADCAST_NOT_ADMIN_NOTICE);
    return;
  }

  // 输入解析（R7）：第一行命令后为标题，其余为正文，二者均必填
  const parsed = parseBroadcastInput(message.text);
  if (!parsed) {
    await sendGeneralText(client, chatId, BROADCAST_USAGE_NOTICE);
    return;
  }

  // 实时落款（R6）：失败不出可确认预览、不用库存旧名称；permanent 尽力提示后终止
  const me = await client.getMe();
  if (!me.ok) {
    if (me.kind === "retryable") throw new Error(me.errorMessage ?? "getMe retryable");
    console.warn(`[broadcast] getMe permanent，终止发起：${me.errorMessage ?? "no detail"}`);
    await sendGeneralText(client, chatId, BROADCAST_GETME_FAILED_NOTICE);
    return;
  }
  const signature = me.result.first_name?.trim() || BROADCAST_FALLBACK_SIGNATURE;
  // 成功后顺带刷新 bots 身份缓存（design §4.2：本次落款直接用本次 API 结果，
  // 不依赖缓存；D1 失败照常抛出 → 重推重跑收敛）
  await upsertBot(env.HODOR_DB, {
    botId,
    username: me.result.username ?? "",
    displayName: signature,
  });

  // 组装 + 最终可见文本长度校验（R8）：超长拒绝，不截断、不拆分
  const composition = composeBroadcast(parsed.title, parsed.body, signature);
  if (!composition) {
    await sendGeneralText(client, chatId, formatBroadcastTooLong(BROADCAST_MAX_VISIBLE_LENGTH));
    return;
  }

  // 惰性清理（design §7.1）：过期草稿 / 滞留 sending 收敛并更新 General 控制消息
  await cleanupStaleAndFinalize(env.HODOR_DB, client, botId);

  // webhook 重推复用（design §7.1）：按 source_update_id 读取既有行，
  // 从已落库的进度续做（重推最多产生一份可执行任务）
  const existing = await findBroadcastBySourceUpdate(env.HODOR_DB, botId, updateId);
  if (existing) {
    if (existing.status === "preparing") {
      const estimate = await countEligibleRecipients(env.HODOR_DB, botId);
      await continuePreparing(env, client, botId, existing, chatId, estimate);
    }
    // pending = 创建已完成；其余状态 = 任务已越过草稿（确认流程自治）——
    // 命令重跑都无事可做
    return;
  }

  // 同 Bot 已有草稿/待确认 → 拒绝新建（R10：草稿唯一；sending 不拦创建，
  // 由确认阶段的 busy 分支拦截）
  const draft = await findActiveDraft(env.HODOR_DB, botId);
  if (draft) {
    await sendGeneralText(client, chatId, BROADCAST_DRAFT_EXISTS_NOTICE);
    return;
  }

  // 预计人数（R8）：0 只提示（不提供可确认广播）；超过 500 拒绝，不截断
  const estimate = await countEligibleRecipients(env.HODOR_DB, botId);
  if (estimate === 0) {
    await sendGeneralText(client, chatId, BROADCAST_EMPTY_RECIPIENTS_NOTICE);
    return;
  }
  if (estimate > BROADCAST_RECIPIENT_LIMIT) {
    await sendGeneralText(client, chatId, formatBroadcastTooManyRecipients(BROADCAST_RECIPIENT_LIMIT));
    return;
  }

  await insertPreparingBroadcast(env.HODOR_DB, {
    botId,
    sourceUpdateId: updateId,
    initiatorUserId: from.id,
    supportChatId: chatId,
    messageHtml: composition.messageHtml,
    expiresAt: new Date(Date.now() + BROADCAST_PREVIEW_TTL_MS).toISOString(),
  });
  const row = await findBroadcastBySourceUpdate(env.HODOR_DB, botId, updateId);
  if (!row) {
    // 防御式：插入后立即读取失败（D1 故障）按 retryable 抛出重推
    throw new Error("broadcast row missing after insert");
  }
  await continuePreparing(env, client, botId, row, chatId, estimate);
}

/**
 * 补齐 preparing 行的两条 General 消息（design §7.1）：预览公告 → 控制消息 →
 * pending。每步幂等：preview_msg_id / control_msg_id 已落库的步骤跳过
 * （webhook 重推从既有进度续做）。
 */
async function continuePreparing(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  row: BroadcastRow,
  chatId: number,
  estimatedCount: number,
): Promise<void> {
  /* ---- ① 公告预览：与用户最终收到的公告完全同 text 同 parse_mode ---- */
  let previewMsgId = row.preview_msg_id;
  if (previewMsgId === null) {
    const preview = await client.sendMessage({
      chat_id: chatId,
      text: row.message_html,
      parse_mode: "HTML",
    });
    if (!preview.ok) {
      if (preview.kind === "retryable") {
        throw new Error(preview.errorMessage ?? "broadcast preview retryable");
      }
      // permanent：预览发不出 → 任务终止；行尚无按钮，删行即无残留任务
      console.warn(
        `[broadcast] 预览发送 permanent，任务终止：${preview.errorMessage ?? "no detail"}`,
      );
      await deleteBroadcast(env.HODOR_DB, botId, row.id);
      await replyGeneralBestEffort(client, chatId, BROADCAST_PREVIEW_CREATE_FAILED_NOTICE);
      return;
    }
    previewMsgId = preview.result.message_id;
    try {
      await setBroadcastPreviewMsgId(env.HODOR_DB, botId, row.id, previewMsgId);
    } catch (error) {
      // 非原子窗口补偿（design §7.1）：预览已发出但 ID 未落库——尽力提示后
      // 抛出交重推；重发一份预览属已接受代价（孤立草稿不持有可执行任务）
      await replyGeneralBestEffort(client, chatId, BROADCAST_PREVIEW_CREATE_FAILED_NOTICE);
      throw error;
    }
  }

  /* ---- ② 控制消息：回复预览，携带确认 / 取消按钮 ---- */
  const control = await client.sendMessage({
    chat_id: chatId,
    text: formatBroadcastControlText(estimatedCount, BROADCAST_PREVIEW_TTL_MINUTES),
    reply_parameters: { message_id: previewMsgId },
    reply_markup: buildBroadcastKeyboard(row.id),
  });
  if (!control.ok) {
    if (control.kind === "retryable") {
      throw new Error(control.errorMessage ?? "broadcast control retryable");
    }
    // permanent：按钮不可用 → 任务终止（同 ① 姿态）
    console.warn(
      `[broadcast] 控制消息发送 permanent，任务终止：${control.errorMessage ?? "no detail"}`,
    );
    await deleteBroadcast(env.HODOR_DB, botId, row.id);
    await replyGeneralBestEffort(client, chatId, BROADCAST_CONTROL_CREATE_FAILED_NOTICE);
    return;
  }
  // 落库成功并进入 pending 后按钮才可确认（callback 严格匹配库存 control_msg_id）。
  // 控制消息已发送但 D1 落库失败：尽力编辑为「按钮无效」并移除键盘，再抛出
  // 交重推；极端 Telegram/D1 双故障可能留孤立消息，但它不持有可执行任务。
  try {
    await setBroadcastPendingWithControlMsgId(env.HODOR_DB, botId, row.id, control.result.message_id);
  } catch (error) {
    const invalidated = await client.editMessageText({
      chat_id: chatId,
      message_id: control.result.message_id,
      text: BROADCAST_CONTROL_CREATE_FAILED_NOTICE,
      reply_markup: EMPTY_BROADCAST_KEYBOARD,
    });
    if (!invalidated.ok) {
      console.warn(
        `[broadcast] 控制消息补偿编辑失败：${invalidated.errorMessage ?? "no detail"}`,
      );
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 确认 / 取消回调 → 同请求内整批发送                                   */
/* ------------------------------------------------------------------ */

/** 处理客服群广播按钮回调（webhook classify=group_callback 按 `b:` 前缀派发） */
export async function handleBroadcastCallback(
  env: Cloudflare.Env,
  botId: number,
  callback: TelegramCallbackQueryRef,
): Promise<void> {
  const data = typeof callback.data === "string" ? callback.data : "";
  const parsed = parseCallbackData(data);
  const message = callback.message;
  const supportChatId = parseSupportChatId(env);
  // 毒丸防护：载荷 / 信封形态不符 → 静默完成（wipe 同姿态）
  if (!parsed || !message || supportChatId === null || message.chat.id !== supportChatId) return;

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  // 惰性清理先于读取：过期 / 滞留任务收敛为终态并尽力更新控制消息
  await cleanupStaleAndFinalize(env.HODOR_DB, client, botId);

  const row = await findBroadcastById(env.HODOR_DB, botId, parsed.id);
  // 孤立 / 重复回调：行已删、控制消息不匹配（非库存按钮）→ 一律「已处理」，
  // 绝不凭按钮载荷发起任何发送
  if (!row || row.control_msg_id === null || row.control_msg_id !== message.message_id) {
    await answerBestEffort(client, callback.id, BROADCAST_TOAST_ALREADY_HANDLED);
    return;
  }

  // 再次鉴权（R9）：键盘只出现在客服群，但仍不信任点击者 = 管理员
  if (!parseAdminIds(env).includes(callback.from.id)) {
    await answerBestEffort(client, callback.id, BROADCAST_TOAST_NOT_ADMIN);
    return;
  }
  // 发起人限定（R9）：其他管理员也不能代替确认
  if (callback.from.id !== row.initiator_user_id) {
    await answerBestEffort(client, callback.id, BROADCAST_TOAST_NOT_INITIATOR);
    return;
  }

  await dispatchBroadcastCallback(env, client, botId, callback, parsed.confirm, row);
}

/**
 * 按行状态分派（穷举 switch；design §7.2/§7.3/§7.4）。并发裁决失败（lost）
 * 时重读一次再分派——状态只向前迁移，至多多跳一次即收敛。
 */
async function dispatchBroadcastCallback(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  callback: TelegramCallbackQueryRef,
  confirm: boolean,
  row: BroadcastRow,
): Promise<void> {
  switch (row.status) {
    case "pending": {
      const now = new Date().toISOString();
      if (row.expires_at <= now) {
        // 已过期：原子置 expired（与惰性清理同语义）+ 终态收尾
        if (await expireBroadcast(env.HODOR_DB, botId, row.id, now)) {
          await finishTerminal(env, client, botId, row, callback.id, BROADCAST_EXPIRED_TEXT, BROADCAST_TOAST_EXPIRED);
          return;
        }
        await redispatch(env, client, botId, callback, confirm, row.id);
        return;
      }
      await handlePendingCallback(env, client, botId, callback, confirm, row);
      return;
    }
    case "sending":
      // cleanup 已把陈旧行置 failed；仍是 sending = 有正在执行的循环 →
      // toast 后直接结束，绝不并发第二份发送（design §7.4）
      await answerBestEffort(client, callback.id, BROADCAST_TOAST_SENDING);
      return;
    case "completed":
      // 幂等修复路径（design §7.3）：最终统计编辑失败的 webhook 重投重跑——
      // 只重做控制消息编辑与删行，绝不重发公告
      await finishTerminal(
        env,
        client,
        botId,
        row,
        callback.id,
        formatBroadcastDoneText(row.success_count, row.failure_count),
        BROADCAST_TOAST_DONE,
      );
      return;
    case "cancelled":
      // 取消收尾编辑失败的重投修复
      await finishTerminal(env, client, botId, row, callback.id, BROADCAST_CANCELLED_TEXT, BROADCAST_TOAST_ALREADY_HANDLED);
      return;
    case "expired":
      await finishTerminal(env, client, botId, row, callback.id, BROADCAST_EXPIRED_TEXT, BROADCAST_TOAST_EXPIRED);
      return;
    case "failed":
      // 崩溃滞留 / 发送中清库：中断语义（结果未知，不补发）
      await finishTerminal(env, client, botId, row, callback.id, BROADCAST_INTERRUPTED_TEXT, BROADCAST_TOAST_ALREADY_HANDLED);
      return;
    case "preparing":
      // 按钮只在进入 pending 后才存在；防御分支（不可达）
      await answerBestEffort(client, callback.id, BROADCAST_TOAST_ALREADY_HANDLED);
      return;
  }
}

/** 并发裁决失败后的重读分派（行可能已被胜方删除） */
async function redispatch(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  callback: TelegramCallbackQueryRef,
  confirm: boolean,
  broadcastId: number,
): Promise<void> {
  const current = await findBroadcastById(env.HODOR_DB, botId, broadcastId);
  if (!current || current.control_msg_id === null) {
    await answerBestEffort(client, callback.id, BROADCAST_TOAST_ALREADY_HANDLED);
    return;
  }
  await dispatchBroadcastCallback(env, client, botId, callback, confirm, current);
}

/**
 * 终态收尾（design §7.3）：控制消息改终态文案 → 删行 → toast。
 * 编辑 retryable → 抛出（webhook 重投重跑见终态行 → 幂等修复路径只重做编辑
 * 与删行）；编辑 permanent（含重复 edit 的 "message is not modified"）→ warn
 * 后照常删行结束。General 消息是唯一历史。
 */
async function finishTerminal(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  row: BroadcastRow,
  callbackQueryId: string,
  text: string,
  toastText: string,
): Promise<void> {
  const edited = await client.editMessageText({
    chat_id: row.support_chat_id,
    message_id: row.control_msg_id!,
    text,
    reply_markup: EMPTY_BROADCAST_KEYBOARD,
  });
  if (!edited.ok && edited.kind === "retryable") {
    throw new Error(edited.errorMessage ?? "editMessageText retryable");
  }
  if (!edited.ok) {
    console.warn(
      `[broadcast] 控制消息终态编辑 permanent，跳过：${edited.errorMessage ?? "no detail"}`,
    );
  }
  await deleteBroadcast(env.HODOR_DB, botId, row.id);
  await answerBestEffort(client, callbackQueryId, toastText);
}

/** pending 主流程：取消 / 确认（design §7.2） */
async function handlePendingCallback(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  callback: TelegramCallbackQueryRef,
  confirm: boolean,
  row: BroadcastRow,
): Promise<void> {
  const now = new Date().toISOString();

  /* ---- 取消：原子 pending → cancelled，先到先得 ---- */
  if (!confirm) {
    if (
      await cancelBroadcast(env.HODOR_DB, {
        botId,
        id: row.id,
        initiatorUserId: callback.from.id,
        now,
      })
    ) {
      await finishTerminal(env, client, botId, row, callback.id, BROADCAST_CANCELLED_TEXT, BROADCAST_TOAST_CANCELLED);
      return;
    }
    await redispatch(env, client, botId, callback, confirm, row.id);
    return;
  }

  /* ---- 确认：冻结名单（同资格语义整查询）---- */
  const recipients = await listEligibleRecipients(env.HODOR_DB, botId);
  if (recipients.length === 0 || recipients.length > BROADCAST_RECIPIENT_LIMIT) {
    // 人数失效（0 或超上限）：原子改 cancelled 终态，绝不因人数再次变化复活
    if (
      await cancelBroadcast(env.HODOR_DB, {
        botId,
        id: row.id,
        initiatorUserId: callback.from.id,
        now,
      })
    ) {
      const text =
        recipients.length === 0 ? BROADCAST_NO_RECIPIENTS_TEXT : formatBroadcastTooManyRecipients(BROADCAST_RECIPIENT_LIMIT);
      await finishTerminal(env, client, botId, row, callback.id, text, BROADCAST_TOAST_CANCELLED);
      return;
    }
    await redispatch(env, client, botId, callback, confirm, row.id);
    return;
  }

  // 原子确认：pending → sending 并冻结排序 JSON（「每 Bot 恰一份 sending」
  // 部分唯一索引裁决并发）；busy 时 pending 保留至自然过期（R10）
  const outcome = await confirmBroadcast(env.HODOR_DB, {
    botId,
    id: row.id,
    initiatorUserId: callback.from.id,
    recipientIdsJson: JSON.stringify(recipients),
    expectedCount: recipients.length,
    now,
  });
  if (outcome === "busy") {
    await answerBestEffort(client, callback.id, BROADCAST_TOAST_BUSY);
    return;
  }
  if (outcome === "lost") {
    await redispatch(env, client, botId, callback, confirm, row.id);
    return;
  }

  // 胜出：从 D1 读取并校验被冻结的 unknown JSON（fail-closed，不直接信任内存名单
  // 或损坏的数据库值）；行已被 /wipealldata 同步取消 / 删除时不再发任何消息
  const claimed = await findBroadcastById(env.HODOR_DB, botId, row.id);
  if (!claimed || claimed.status !== "sending") {
    await answerBestEffort(client, callback.id, BROADCAST_TOAST_ALREADY_HANDLED);
    return;
  }
  const frozenRecipients = decodeRecipientIds(claimed.recipient_ids_json);
  if (frozenRecipients === null) {
    console.warn(`[broadcast] 广播 ${row.id} 收件人快照损坏，fail-closed：不发送任何用户消息`);
  }
  await answerBestEffort(client, callback.id, BROADCAST_TOAST_CONFIRMED);
  await runSendLoop(env, client, botId, claimed, frozenRecipients);
}

/**
 * 发送循环（design §7.3，确认回调请求内）：
 * 1. 一次性资格复核（整查询交集，绝不逐人查库）；资格已变化者计失败不发送。
 * 2. 控制消息改「正在发送…」：失败只 warn，不阻断主循环。
 * 3. 顺序逐位 sendMessage（冻结 message_html + HTML）；三态消费见模块头注释。
 * 4. 一次 UPDATE 置 completed + 总数 → 编辑最终统计（retryable 抛出交重投；
 *    permanent warn）→ 删行。
 */
async function runSendLoop(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  row: BroadcastRow,
  frozenRecipients: number[] | null,
): Promise<void> {
  const controlMsgId = row.control_msg_id!;

  // ① 发送前一次性资格复核：冻结数组是上界，交集才是实际发送名单。
  //    快照损坏时 fail-closed：全部 expected_count 计失败，绝不执行任意 chat ID。
  const eligible = frozenRecipients === null
    ? new Set<number>()
    : new Set(await listEligibleRecipients(env.HODOR_DB, botId));
  const targets = frozenRecipients === null
    ? []
    : frozenRecipients.filter((userId) => eligible.has(userId));
  let successCount = 0;
  let failureCount = frozenRecipients === null
    ? row.expected_count
    : frozenRecipients.length - targets.length;

  // ② 「正在发送…」完全 best-effort：两种失败都只 warn；成功时显式移除
  //    确认键盘（Telegram editMessageText 不传 reply_markup 会保留原键盘）
  const sending = await client.editMessageText({
    chat_id: row.support_chat_id,
    message_id: controlMsgId,
    text: BROADCAST_SENDING_TEXT,
    reply_markup: EMPTY_BROADCAST_KEYBOARD,
  });
  if (!sending.ok) {
    console.warn(
      `[broadcast] 发送中状态编辑失败（继续发送）：${sending.errorMessage ?? "no detail"}`,
    );
  }

  // ③ 顺序逐位发送（顺序 await 天然自限速，符合 Telegram 单聊速率指引）；
  //    每位开始前读取任务状态：/wipealldata 会将 sending 原子改为 failed，
  //    清库后行消失；观察到两者之一即停止，避免清库后继续向后续用户群发。
  //    检查与 Telegram 请求之间仍有不可消除的竞态：当时已开始的单条请求
  //    可能成功，故控制消息必须标记结果未知而不是「未发送」。
  let interrupted = false;
  for (const userId of targets) {
    if (!(await isBroadcastSending(env.HODOR_DB, botId, row.id))) {
      interrupted = true;
      break;
    }
    const sent = await client.sendMessage({
      chat_id: userId,
      text: row.message_html,
      parse_mode: "HTML",
    });
    if (sent.ok) {
      successCount++;
      continue;
    }
    if (sent.kind === "permanent") {
      // 含 403（用户拉黑 bot）：失败继续，不改 users 状态
      failureCount++;
      console.warn(
        `[broadcast] 用户 ${userId} 发送失败（permanent，继续）：${sent.errorMessage ?? "no detail"}`,
      );
      continue;
    }
    if (sent.retryAfterSeconds !== undefined) {
      // 429（client 已原地重试过一次，此处 retry_after > 3s）：有界 sleep 后
      // 重试恰一次；仍失败计失败继续，绝不无限阻断整份广播（PRD R3）
      await sleep(Math.min(sent.retryAfterSeconds, BROADCAST_RETRY_SLEEP_MAX_SECONDS) * 1000);
      const retried = await client.sendMessage({
        chat_id: userId,
        text: row.message_html,
        parse_mode: "HTML",
      });
      if (retried.ok) {
        successCount++;
        continue;
      }
    }
    failureCount++;
    console.warn(
      `[broadcast] 用户 ${userId} 发送失败（retryable，计失败继续）：${sent.errorMessage ?? "no detail"}`,
    );
  }

  // 清库 / 中断把任务改为 failed（或已删除）后，已进入发送窗口的单条请求
  // 无法撤回；停止剩余收件人并诚实标记结果未知。该消息留在 General，且不
  // 留下可执行任务。展示失败只 warn——任务状态已不可恢复，不能靠 webhook 重推重发。
  if (interrupted) {
    const edited = await client.editMessageText({
      chat_id: row.support_chat_id,
      message_id: controlMsgId,
      text: BROADCAST_INTERRUPTED_TEXT,
      reply_markup: EMPTY_BROADCAST_KEYBOARD,
    });
    if (!edited.ok) {
      console.warn(`[broadcast] 中断状态编辑失败：${edited.errorMessage ?? "no detail"}`);
    }
    await deleteBroadcast(env.HODOR_DB, botId, row.id);
    return;
  }

  // ④ 结束：一次 UPDATE 写入完成状态与统计。清库 / 陈旧清理若刚在最后一次
  // 状态检查之后改写了行，UPDATE 返回 false；结果应按中断未知处理，不能误报完成。
  const completed = await completeBroadcast(env.HODOR_DB, {
    botId,
    id: row.id,
    successCount,
    failureCount,
    now: new Date().toISOString(),
  });
  if (!completed) {
    const edited = await client.editMessageText({
      chat_id: row.support_chat_id,
      message_id: controlMsgId,
      text: BROADCAST_INTERRUPTED_TEXT,
      reply_markup: EMPTY_BROADCAST_KEYBOARD,
    });
    if (!edited.ok) {
      console.warn(`[broadcast] 中断状态编辑失败：${edited.errorMessage ?? "no detail"}`);
    }
    await deleteBroadcast(env.HODOR_DB, botId, row.id);
    return;
  }

  // 最终统计编辑：retryable → 抛出（重投重跑见 completed → 修复路径只重做
  // 编辑与删行，绝不重发公告）；permanent → warn 后删行结束
  const edited = await client.editMessageText({
    chat_id: row.support_chat_id,
    message_id: controlMsgId,
    text: formatBroadcastDoneText(successCount, failureCount),
    reply_markup: EMPTY_BROADCAST_KEYBOARD,
  });
  if (!edited.ok && edited.kind === "retryable") {
    throw new Error(edited.errorMessage ?? "final stats edit retryable");
  }
  if (await findBroadcastById(env.HODOR_DB, botId, row.id)) {
    await deleteBroadcast(env.HODOR_DB, botId, row.id);
  }
  if (!edited.ok) {
    console.warn(
      `[broadcast] 完成统计编辑 permanent，跳过：${edited.errorMessage ?? "no detail"}`,
    );
  }
}
