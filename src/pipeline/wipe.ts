/**
 * /wipealldata 确认回调管线（T40，design.md §四）：客服群内警告消息按钮的
 * 点击处理（classify=group_callback 派发到本模块）。
 *
 * 无状态两步确认：确认窗口编入 callback_data（`w:yes:<unix秒>` / `w:no:<unix秒>`），
 * 服务端零表——60 秒有效期、再次鉴权、幂等执行全部在回调内收敛：
 *
 * 1. 载荷非 `w:(yes|no):<数字>` / 缺 message → 静默完成（毒丸防护，零 API 调用）；
 * 2. **再次鉴权**：from.id ∈ ADMIN_IDS 否 → toast 拒绝，零 DB 写；
 * 3. 超过 60 秒窗口 → toast 已超时放弃（需重新 /wipealldata 发起新键盘）；
 * 4. 取消 → toast + 编辑原消息移除键盘（best-effort）；
 * 5. 确认 → toast「正在清空」→ wipeAllUserData（users/topics/messages 三表
 *    DELETE；settings / processed_updates / bots 永不清）→ 编辑原消息为
 *    完成文案（permanent → warn 吞）。
 *
 * 重放 / 重复点击：三表 DELETE 幂等（空表无害）；answerCallbackQuery 对已
 * 消费 id 会 permanent → warn 吞（verify.ts 同款姿态）。确认后 edit 失败
 * permanent → warn 吞（数据已清，文案是展示面）。
 */
import {
  WIPE_CANCEL_LABEL,
  WIPE_CONFIRM_LABEL,
  WIPE_DONE_TEXT,
  WIPE_TOAST_CANCELLED,
  WIPE_TOAST_EXPIRED,
  WIPE_TOAST_NOT_ADMIN,
  WIPE_TOAST_RUNNING,
  WIPE_WARNING_TEXT,
} from "../copy";
import { parseAdminIds } from "../env";
import { wipeAllUserData } from "../store/wipe";
import { createTelegramClient } from "../telegram/client";
import type { InlineKeyboardMarkup, TelegramClient } from "../telegram/types";
import type { TelegramCallbackQueryRef } from "./classify";

/** 确认窗口：发起（bot 发键盘消息）到点击（回调到达）的最大间隔秒数 */
export const WIPE_CALLBACK_TIMEOUT_SECONDS = 60;

/**
 * 组装两步确认键盘（commands.ts /wipealldata 第一步调用）。
 * epochSeconds = Math.floor(Date.now() / 1000)：同一 Worker 秒级时钟，
 * 与回调侧 Date.now() 比较无跨实例漂移问题。
 */
export function buildWipeKeyboard(epochSeconds: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: WIPE_CONFIRM_LABEL, callback_data: `w:yes:${epochSeconds}` },
        { text: WIPE_CANCEL_LABEL, callback_data: `w:no:${epochSeconds}` },
      ],
    ],
  };
}

/** 解析按钮载荷：`w:yes|no:<1-12 位数字>` → { confirm, epoch }；其余 null */
function parseWipeData(
  data: string,
): { confirm: boolean; epoch: number } | null {
  const match = data.match(/^w:(yes|no):(\d{1,12})$/);
  if (!match) return null;
  return { confirm: match[1] === "yes", epoch: Number(match[2]) };
}

/** answerCallbackQuery 三态消费：retryable → 抛（重推）；permanent → warn 吞 */
async function answerQuery(
  client: TelegramClient,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  const answered = await client.answerCallbackQuery({ callbackQueryId, text });
  if (!answered.ok) {
    if (answered.kind === "retryable") {
      throw new Error(answered.errorMessage ?? "answerCallbackQuery retryable");
    }
    console.warn(
      `[wipe] callback ${callbackQueryId}: answerCallbackQuery permanent，跳过：${answered.errorMessage ?? "no detail"}`,
    );
  }
}

/** editMessageText 三态消费：retryable → 抛；permanent → warn 吞（展示面） */
async function editMessage(
  client: TelegramClient,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  const edited = await client.editMessageText({ chat_id: chatId, message_id: messageId, text });
  if (!edited.ok) {
    if (edited.kind === "retryable") {
      throw new Error(edited.errorMessage ?? "editMessageText retryable");
    }
    console.warn(
      `[wipe] message ${messageId}: 完成 / 取消文案编辑 permanent，跳过：${edited.errorMessage ?? "no detail"}`,
    );
  }
}

/** 处理客服群内 wipe 确认按钮回调（webhook classify=group_callback 派发） */
export async function handleWipeCallback(
  env: Cloudflare.Env,
  botId: number,
  callback: TelegramCallbackQueryRef,
): Promise<void> {
  // 1. 毒丸防护：载荷形态不符（含缺 message）→ 静默完成
  const data = typeof callback.data === "string" ? callback.data : "";
  const parsed = parseWipeData(data);
  const message = callback.message;
  if (!parsed || !message) return;

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  // 2. 再次鉴权（键盘只出现在客服群，但仍不信任点击者 = 管理员）
  if (!parseAdminIds(env).includes(callback.from.id)) {
    await answerQuery(client, callback.id, WIPE_TOAST_NOT_ADMIN);
    return;
  }

  // 3. 60 秒窗口（epoch 为发起时刻；向后漂移的伪造就值只会更旧 → 超时）
  const ageSeconds = Date.now() / 1000 - parsed.epoch;
  if (ageSeconds > WIPE_CALLBACK_TIMEOUT_SECONDS) {
    await answerQuery(client, callback.id, WIPE_TOAST_EXPIRED);
    return;
  }

  // 4. 取消：toast + 原消息去键盘（重发同一文案——只有键盘是状态）
  if (!parsed.confirm) {
    await answerQuery(client, callback.id, WIPE_TOAST_CANCELLED);
    await editMessage(client, message.chat.id, message.message_id, WIPE_WARNING_TEXT);
    return;
  }

  // 5. 确认：toast → 三表清空 → 原消息改完成文案（键盘随之移除）。
  // botId 形参保留给未来多 bot 隔离（阶段 8）；单 bot 语义下三表全清即归属清理
  await answerQuery(client, callback.id, WIPE_TOAST_RUNNING);
  await wipeAllUserData(env.HODOR_DB);
  await editMessage(client, message.chat.id, message.message_id, WIPE_DONE_TEXT);
}
