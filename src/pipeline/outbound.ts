/**
 * 出站管线（T21，design.md「出站管线」逐字执行）：
 *
 * message(SUPPORT_CHAT_ID, thread_id, text)
 *   → 发言者 ∈ ADMIN_IDS？否 → 静默完成（非管理员发言不中继）
 *   → findUserIdByThread(bot_id, thread_id) → 未命中 / closed → 静默完成
 *     （「找不到对应用户」提示是 T26 / 阶段 3）
 *   → sendMessage(用户私聊, text)（不带 thread）
 *
 * 中继用 sendMessage（入站同为 sendMessage，2026-09-30 定稿）：出站不用
 * forwardMessage——forward 头会向用户泄漏客服群名；copyMessage 在生产
 * bot 上全场景 400「message to copy not found」，保留在 client 备用，
 * T22 / 阶段 3 重审媒体路径。
 *
 * TelegramResult 消费（error-handling spec）：retryable → 抛（→ webhook 500 重推）；
 * permanent（如 403 bot 被用户拉黑 / 400 毒丸）→ warn + 按已处理跳过，绝不 5xx。
 */
import { parseAdminIds } from "../env";
import { findUserIdByThread } from "../store/topics";
import { createTelegramClient } from "../telegram/client";
import type { TelegramMessageRef } from "./classify";

/** 处理一条客服群 topic 内的 message。完成 = 按成功处理；抛出 = retryable 重推。 */
export async function handleOutbound(
  env: Cloudflare.Env,
  botId: number,
  message: TelegramMessageRef,
): Promise<void> {
  // 阶段 2 只中继文本：非文本静默完成，零副作用
  if (typeof message.text !== "string" || message.text === "") return;
  const from = message.from;
  if (!from || typeof from.id !== "number") return;

  // 非管理员在客服群的发言一律不中继
  if (!parseAdminIds(env).includes(from.id)) return;

  // classify 已保证 outbound 带 message_thread_id；缺线程号视同畸形，静默完成
  const threadId = message.message_thread_id;
  if (typeof threadId !== "number") return;

  const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
  // 未命中或 closed → 静默忽略（closed 对出站视同未绑定）
  if (!owner || owner.status !== "open") return;

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const relayed = await client.sendMessage({
    chat_id: owner.user_id,
    text: message.text,
  });
  if (!relayed.ok) {
    if (relayed.kind === "retryable") {
      throw new Error(relayed.errorMessage ?? "sendMessage retryable");
    }
    console.warn(
      `[outbound] thread ${threadId} → user ${owner.user_id}: sendMessage permanent，按已处理跳过：${relayed.errorMessage ?? "no detail"}`,
    );
  }
}
