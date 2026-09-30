/**
 * 命令管线（T34 /help + T35 /ban /unban，design.md §二.6 + §四失败表）：
 *
 * outbound 在管理员校验后把 `/` 开头的文本消息整条移交本管线——**一律按
 * 命令终结，永不中继、永不写账本**（命令是客服侧治理操作而非对话内容）；
 * 非管理员 `/` 沿用阶段 3 静默（outbound 管理员校验已挡，本文件不重复判）。
 *
 * 命令语义：
 * - /help → 回当前 topic HELP_TEXT（只列已交付命令 + 「/ 开头消息不中继」）
 * - /ban / /unban → 反查绑定（**open 与 closed 均可操作**——治理操作不依赖
 *   topic 开放；无绑定 → 复用 T26 UNBOUND_TOPIC_NOTICE）→ setBanned
 *   （DB 真值先行，幂等 setter——确认消息失败重推不产生二次状态翻转）
 *   → topic 内确认（携带目标用户 ID 便于管理员核对）
 * - 未知命令 → topic 内「未知命令」提示并引导 /help，**绝不发给用户**
 *
 * 失败语义（design.md §四「命令回复」行，binding）：回复 retryable → 抛
 * （webhook 500 → 重推重发回复）；permanent → warn 吞（跳过该条回复）。
 * 命令回复全部发回管理员发言的同一 topic（classify 保证 chat 即客服群）：
 * 零用户侧消息、零 messages 账本行（系统消息不入账本，error-handling spec）。
 */
import {
  formatBanConfirmed,
  formatUnbanConfirmed,
  HELP_TEXT,
  UNBOUND_TOPIC_NOTICE,
  UNKNOWN_COMMAND_NOTICE,
} from "../copy";
import { findUserIdByThread } from "../store/topics";
import { setBanned } from "../store/users";
import { createTelegramClient } from "../telegram/client";

/**
 * 解析命令名：首 token 去 `@botname` 后缀（`/ban@hodor_bot 附加参数` →
 * `/ban`）。命令只看首 token，参数一律忽略（本阶段无带参命令）；是否为
 * 命令（`/` 前缀）由调用方 outbound 先行判定。
 */
export function parseCommandName(text: string): string {
  const firstToken = text.split(/\s+/)[0] ?? "";
  const at = firstToken.indexOf("@");
  return at === -1 ? firstToken : firstToken.slice(0, at);
}

/** topic 内命令回复的三态消费：retryable → 抛（重推）；permanent → warn 吞 */
async function replyInTopic(
  env: Cloudflare.Env,
  chatId: number,
  threadId: number,
  text: string,
): Promise<void> {
  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const sent = await client.sendMessage({ chat_id: chatId, text, message_thread_id: threadId });
  if (!sent.ok) {
    if (sent.kind === "retryable") {
      throw new Error(sent.errorMessage ?? "sendMessage retryable");
    }
    console.warn(
      `[commands] thread ${threadId}: 命令回复 permanent，跳过：${sent.errorMessage ?? "no detail"}`,
    );
  }
}

/**
 * 处理一条管理员命令（outbound 管理员校验 + thread 校验后移交）。
 * 完成（resolve）= 按成功处理；抛出（reject）= retryable，交 webhook 500 重推。
 * 无论命中哪条分支，本函数返回后该 update 即告终结——outbound 不再走
 * 绑定查找 / 中继 / 账本（「/ 开头永不中继」的唯一保证点）。
 */
export async function handleCommand(
  env: Cloudflare.Env,
  botId: number,
  params: { chatId: number; threadId: number; text: string },
): Promise<void> {
  const { chatId, threadId } = params;
  const name = parseCommandName(params.text);

  if (name === "/help") {
    // /help 不依赖绑定：无论哪个 topic 都能看（含无绑定 / closed topic）
    await replyInTopic(env, chatId, threadId, HELP_TEXT);
    return;
  }

  if (name === "/ban" || name === "/unban") {
    // 反查绑定：closed 行同样可操作（管理操作不依赖 open——区别于中继的
    // 「closed 视同未绑定」）；无行 → 复用 T26 提示（绝不猜测目标用户）
    const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
    if (!owner) {
      await replyInTopic(env, chatId, threadId, UNBOUND_TOPIC_NOTICE);
      return;
    }
    // DB 真值先行（幂等 setter）：确认回复 retryable → 抛 → 重推只会
    // 重发回复并重复执行同一赋值，不产生状态振荡或用户侧副作用
    await setBanned(env.HODOR_DB, botId, owner.user_id, name === "/ban");
    await replyInTopic(
      env,
      chatId,
      threadId,
      name === "/ban"
        ? formatBanConfirmed(owner.user_id)
        : formatUnbanConfirmed(owner.user_id),
    );
    return;
  }

  // 未知命令（含 /、/foo、群内误用的 /start 等）：提示管理员并引导 /help
  await replyInTopic(env, chatId, threadId, UNKNOWN_COMMAND_NOTICE);
}
