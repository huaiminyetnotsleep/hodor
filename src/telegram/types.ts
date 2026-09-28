/**
 * telegram · 三态结果类型与 Bot API 结构类型（S2，docs/03「Telegram API 错误分类与处理」）。
 *
 * TelegramResult 是全管线唯一错误语言：错误分类只发生在 client 的 request() 内，
 * pipeline 收到的永远是 成功 / retryable / permanent 三态之一，不感知 HTTP 细节。
 */

// ── 三态结果（docs/03 决策表，design.md 契约）─────────────────────────────

export type TelegramOk<T> = { ok: true; result: T };

export type TelegramError =
  | { ok: false; kind: 'retryable'; retryAfterSeconds?: number; errorMessage?: string } // 5xx/网络/非 JSON；429 超预算
  | { ok: false; kind: 'permanent'; errorMessage?: string }; // 400 毒丸 / 403 拉黑 / 其他 4xx

export type TelegramResult<T> = TelegramOk<T> | TelegramError;

// ── Bot API 结果结构（只声明本仓库消费的字段，响应原样透传不额外解析）─────

/** copyMessage → MessageId */
export interface TelegramMessageId {
  message_id: number;
}

/** createForumTopic → ForumTopic（docs/02 崩溃窗口：只消费 message_thread_id） */
export interface TelegramForumTopic {
  message_thread_id: number;
}

/** Bot API User（getMe；本仓库只消费 id/username/is_bot） */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

/** Bot API ChatMember（getChatMember；出站校验只看 status === 'administrator'，docs/02） */
export interface TelegramChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  user: TelegramUser;
}

/** setMyCommands 的条目 */
export interface TelegramBotCommand {
  command: string;
  description: string;
}

/** getWebhookInfo → WebhookInfo（S9 自检用） */
export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
}

// ── 方法参数（显式命名；camelCase → snake_case 映射收敛在 client 内）──────

export interface CopyMessageParams {
  chatId: number | string;
  fromChatId: number | string;
  messageId: number;
}

export interface CreateForumTopicParams {
  chatId: number | string;
  name: string;
  iconColor?: string;
  iconCustomEmojiId?: string;
}

export interface EditForumTopicParams {
  chatId: number | string;
  messageThreadId: number;
  name?: string;
  iconCustomEmojiId?: string;
}

export interface CloseForumTopicParams {
  chatId: number | string;
  messageThreadId: number;
}

export interface ReopenForumTopicParams {
  chatId: number | string;
  messageThreadId: number;
}

export interface DeleteForumTopicParams {
  chatId: number | string;
  messageThreadId: number;
}

export interface SetMyCommandsParams {
  commands: readonly TelegramBotCommand[];
}

export interface GetChatMemberParams {
  chatId: number | string;
  userId: number;
}

export interface SetWebhookParams {
  url: string;
  secretToken?: string;
  /** docs/03：setWebhook 时显式设置 allowed_updates = ["message"] */
  allowedUpdates?: readonly string[];
  dropPendingUpdates?: boolean;
}

export interface DeleteWebhookParams {
  dropPendingUpdates?: boolean;
}
