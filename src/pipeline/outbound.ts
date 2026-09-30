/**
 * 出站管线（T21 + T22 / T25 / T26，design.md「出站管线」canonical order）：
 *
 * 1. extractContent → 支持集之外静默完成（零副作用）
 * 2. from / 管理员校验（非管理员 → 静默完成，**不触发无绑定提示**）
 * 3. message_thread_id 校验（缺 → 静默完成）
 * 4. findUserIdByThread：命中 open → 继续；未命中 / closed → T26 无绑定
 *    提示发回该 thread（permanent → warn；retryable → 抛交重推）→ 完成
 * 5. 中继：relayContent 到用户私聊（不带 thread；per-type send 按 file_id
 *    直传——不用 forward，forward 头会向用户泄漏客服群名）
 * 6. 账本：中继 ok → insertMessage(direction 'out',
 *    group_msg_id = 管理员原始 message_id（完整落库，供阶段 6 /purgemsg），
 *    private_msg_id = 私聊中继消息 ID)
 *
 * TelegramResult 消费（error-handling spec）：retryable → 抛（→ webhook 500
 * 重推）；permanent（如 403 bot 被用户拉黑 / 400 毒丸）→ warn + 按已处理
 * 跳过且**不写账本**（T25 只记成功中继）；系统提示不入账本。
 */
import { UNBOUND_TOPIC_NOTICE } from "../copy";
import { parseAdminIds } from "../env";
import { insertMessage } from "../store/messages";
import { findUserIdByThread } from "../store/topics";
import { createTelegramClient } from "../telegram/client";
import { extractContent, relayContent } from "./content";
import type { TelegramMessageRef } from "./classify";

/** 处理一条客服群 topic 内的 message。完成 = 按成功处理；抛出 = retryable 重推。 */
export async function handleOutbound(
  env: Cloudflare.Env,
  botId: number,
  message: TelegramMessageRef,
): Promise<void> {
  // 1. 支持集之外 / 畸形内容 → 静默完成（零副作用，不触发提示）
  const payload = extractContent(message);
  if (payload === null) return;
  // 2. 非管理员在客服群的发言一律不中继、不提示
  const from = message.from;
  if (!from || typeof from.id !== "number") return;
  if (!parseAdminIds(env).includes(from.id)) return;

  // classify 已保证 outbound 带 message_thread_id；缺线程号视同畸形，静默完成
  const threadId = message.message_thread_id;
  if (typeof threadId !== "number") return;

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  /* ---------------- 4. 反查绑定（closed 对出站视同未绑定） ---------------- */
  const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
  if (!owner || owner.status !== "open") {
    // T26 无绑定提示：发回管理员发言的同一 topic（classify 保证 message.chat
    // 即客服群，chat.id 运行时已校验为数字）——绝不发往任何用户私聊
    const notice = await client.sendMessage({
      chat_id: message.chat.id,
      text: UNBOUND_TOPIC_NOTICE,
      message_thread_id: threadId,
    });
    if (!notice.ok) {
      if (notice.kind === "retryable") {
        throw new Error(notice.errorMessage ?? "sendMessage retryable");
      }
      console.warn(
        `[outbound] thread ${threadId}: 无绑定提示 permanent，跳过：${notice.errorMessage ?? "no detail"}`,
      );
    }
    return;
  }

  /* ---------------- 5. 中继（私聊不带 thread） ---------------- */
  const relayed = await relayContent(client, payload, { chatId: owner.user_id });
  if (!relayed.ok) {
    if (relayed.kind === "retryable") {
      throw new Error(relayed.errorMessage ?? "relay retryable");
    }
    // permanent：重试无益，消息被丢弃——不写账本
    console.warn(
      `[outbound] thread ${threadId} → user ${owner.user_id}: 中继 permanent，按已处理跳过（消息被丢弃，不写账本）：${relayed.errorMessage ?? "no detail"}`,
    );
    return;
  }

  /* ---------------- 6. 账本（T25 out 行双 ID；失败原样抛 → 重推） ---------------- */
  await insertMessage(env.HODOR_DB, {
    botId,
    userId: owner.user_id,
    threadId,
    direction: "out",
    groupMsgId: message.message_id,
    privateMsgId: relayed.result.message_id,
    contentType: payload.type,
  });
}
