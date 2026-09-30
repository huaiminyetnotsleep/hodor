/**
 * update 分流（T15）：纯函数，无 IO、无副作用。
 *
 * 输入是 webhook 解析出的 JSON（不可信），所以一切字段先做运行时形态校验，
 * 任何不完整 / 非预期形态一律 'ignore'（安全忽略，零副作用）。
 *
 * 规则（design.md「出站管线/入站管线」）：
 * - 无 message（edited_message / callback_query / channel_post 等）→ ignore
 * - chat.type === 'private' → inbound（用户私聊）
 * - chat.id === SUPPORT_CHAT_ID 且带 message_thread_id → outbound（topic 内发言）
 * - chat.id === SUPPORT_CHAT_ID 且无 thread（General / 非 topic）→ ignore
 * - 其他 chat → ignore
 */

export type UpdateClassification = "inbound" | "outbound" | "ignore";

/** update.message.from 的最小子集（入站建档 / 出站管理员判定用） */
export interface TelegramFromRef {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/** update.message 的最小子集（本阶段所需字段） */
export interface TelegramMessageRef {
  message_id: number;
  from?: TelegramFromRef;
  chat: { id: number; type: string };
  /** 阶段 2 仅中继非空 text（媒体是 T22 / 阶段 3） */
  text?: string;
  message_thread_id?: number;
}

/** Telegram update 信封的最小子集（无关字段忽略） */
export interface TelegramUpdateRef {
  update_id: number;
  message?: TelegramMessageRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 分流一条 update。
 *
 * @param update webhook 解析出的 JSON（unknown：字段运行时校验）
 * @param supportChatId 客服超级群 chat_id（parseSupportChatId 结果）
 *
 * supportChatId === null（env 畸形）→ **一切返回 'ignore'（fail-closed）**：
 * 部署配置坏了，任何分流都可能把消息转错群；宁可零副作用地吞掉
 * （webhook 层照常 markProcessed + 200），配置问题由部署侧日志暴露，
 * 绝不能让错误配置产生半吊子副作用后靠 500 重推去放大。
 */
export function classifyUpdate(
  update: unknown,
  supportChatId: number | null,
): UpdateClassification {
  if (supportChatId === null) return "ignore";

  if (!isRecord(update)) return "ignore";
  const message = update.message;
  // edited_message / callback_query 等都不走 .message —— 统一 ignore
  if (!isRecord(message)) return "ignore";
  const chat = message.chat;
  if (!isRecord(chat) || typeof chat.id !== "number" || typeof chat.type !== "string") {
    return "ignore";
  }

  if (chat.type === "private") return "inbound";

  if (chat.id === supportChatId) {
    return typeof message.message_thread_id === "number" ? "outbound" : "ignore";
  }
  return "ignore";
}
