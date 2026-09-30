/**
 * 入站管线（T19 / T20 / T21，design.md「入站管线」逐字执行）：
 *
 * message(private, text) → ensureUser → ensureTopic:
 *   查 (bot_id,user_id) → 命中 open   → 直接用 thread_id
 *                     → 命中 closed → 重开（status='open', closed_at=NULL）
 *                     → 未命中      → createForumTopic(title) → INSERT
 *                        → UNIQUE 冲突（并发首次联系竞态）→ 删除自己刚建的
 *                          → 重查取胜方行（竞态输方清理，不留双有效绑定）
 * copyMessage(user_chat → SUPPORT_CHAT_ID, thread_id)
 *
 * 阶段边界：仅中继 message.text 非空；非文本**先于一切副作用**静默完成
 * （首条非文本不建档不建 topic），update 仍按成功处理（markProcessed + 200）。
 *
 * TelegramResult 消费（error-handling spec）：
 * - retryable → 直接抛（→ webhook 500 → Telegram 重推 + 状态机接管）
 * - permanent → 重试无益：console.warn（已消毒摘要）+ 静默完成（按已处理跳过）。
 *   createForumTopic permanent 意味着本条消息被丢弃——阶段 2 接受该语义
 *   （permanent = 不可恢复），绝不 5xx 死循环。
 */
import { parseSupportChatId } from "../env";
import {
  findTopicByUser,
  insertTopic,
  isUniqueViolation,
  reopenTopic,
  type TopicRow,
} from "../store/topics";
import { ensureUser } from "../store/users";
import { createTelegramClient } from "../telegram/client";
import type { TelegramMessageRef } from "./classify";

/** title 三级回退（建档时定死，不再复算）：first_name → @username → ID_<user_id> */
function resolveTopicTitle(from: { id: number; first_name?: string; username?: string }): string {
  const firstName = from.first_name?.trim();
  if (firstName) return firstName;
  if (from.username) return `@${from.username}`;
  return `ID_${from.id}`;
}

/** retryable → 抛（errorMessage 已由 client 消毒）；permanent → warn + 吞（按已处理跳过） */
function consumeCopyResult(
  userId: number,
  result: { ok: boolean; kind?: "retryable" | "permanent"; errorMessage?: string },
): void {
  if (result.ok) return;
  if (result.kind === "retryable") {
    throw new Error(result.errorMessage ?? "copyMessage retryable");
  }
  console.warn(
    `[inbound] user ${userId}: copyMessage permanent，按已处理跳过（消息被丢弃）：${result.errorMessage ?? "no detail"}`,
  );
}

/**
 * 处理一条私聊 message：建档 → 确保 topic → 中继到客服群。
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

  // 阶段 2 只中继文本：门放在一切副作用之前（非文本不建档、不建 topic）
  if (typeof message.text !== "string" || message.text === "") return;
  // 私聊 message 必带 from；缺 from 视为畸形信封，静默完成零副作用
  const from = message.from;
  if (!from || typeof from.id !== "number") return;

  await ensureUser(env.HODOR_DB, botId, from);

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  /* ---------------- topic 解析 ---------------- */
  const existing = await findTopicByUser(env.HODOR_DB, botId, from.id);
  let threadId: number | null;
  if (existing && existing.status === "open") {
    threadId = existing.thread_id;
  } else if (existing) {
    // closed：终身一个 topic，重开复用（阶段 6 预留语义）
    await reopenTopic(env.HODOR_DB, botId, from.id);
    threadId = existing.thread_id;
  } else {
    threadId = await createTopicWithRaceCleanup(env, client, {
      botId,
      userId: from.id,
      supportChatId,
      title: resolveTopicTitle(from),
    });
  }
  // null = createForumTopic permanent（topic 未建），本条已按已处理丢弃
  if (threadId === null) return;

  /* ---------------- 中继 ---------------- */
  const copied = await client.copyMessage({
    from_chat_id: message.chat.id,
    from_message_id: message.message_id,
    chat_id: supportChatId,
    message_thread_id: threadId,
  });
  consumeCopyResult(from.id, copied);
}

/** 竞态清理的上下文（createTopic 主流程 + 失败路径共用） */
interface CreateTopicContext {
  botId: number;
  userId: number;
  supportChatId: number;
  title: string;
}

/**
 * 未命中映射时的建 topic 主流程：
 * createForumTopic → insertTopic → 唯一冲突（并发首联竞态败方）→
 * deleteForumTopic 清掉自己刚建的（best-effort）→ 重查取胜方行。
 *
 * deleteForumTopic 失败只 warn 不抛：胜方行已保证「单有效绑定」，
 * 重推也永远不会再次走到这里（findTopicByUser 命中），抛了只会让
 * 已可成功的处理失败，孤儿 topic 反正没人再清理。
 */
async function createTopicWithRaceCleanup(
  env: Cloudflare.Env,
  client: ReturnType<typeof createTelegramClient>,
  ctx: CreateTopicContext,
): Promise<number | null> {
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
    return newThreadId;
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
    return winner.thread_id;
  }
}
