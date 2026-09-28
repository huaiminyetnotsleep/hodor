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

/** Bot API User（getMe / message.from；本仓库只消费 id/username/is_bot 与姓名字段） */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  /** display_name 渲染用（docs/03 速查）；可选，判空 */
  last_name?: string;
  username?: string;
}

/** Bot API PhotoSize（photo 数组项；只消费 file_id/width/height，docs/03 判空） */
export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

/** 媒体附件共同形状（voice/video/document/sticker；只消费 file_id，docs/03：不解析本体） */
export interface TelegramFileRef {
  file_id: string;
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
  /** 复制进 Topic 时提供（docs/02：to = (support_chat_id, message_thread_id)，缺省落 General） */
  messageThreadId?: number;
}

/** sendMessage：WELCOME / 服务提示 / 崩溃窗口标记消息（S4 起，docs/02/03） */
export interface SendMessageParams {
  chatId: number | string;
  text: string;
  /** 发进 Topic 时提供（docs/02） */
  messageThreadId?: number;
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

// ── Webhook Update 结构（docs/03「Update 结构速查」，S3 起消费）──────────────
// 与上面的 Bot API 结果结构同属 Telegram 线上格式：只声明本仓库消费的字段，
// 其余字段不解析（判空原则——内容字段全部可选，不得假定存在）。

/** Bot API Chat（webhook 消息内；来源分类只消费 id/type，docs/03） */
export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

/** Bot API Message（webhook message 内容；Phase 1 实际读取字段的清单见 docs/03） */
export interface TelegramMessage {
  message_id: number;
  /** 匿名群身份等场景可能缺失（判空，docs/03） */
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  /** Topic ID；缺失或 1（General）语义见 docs/02/03 */
  message_thread_id?: number;
  text?: string;
  caption?: string;
  /**
   * 媒体内容字段（互斥出现；docs/03：不解析文件本体，只取 file_id 落库）。
   * 未声明的媒体类型（audio/video_note/animation 等）不解析，content_type 回落 'text'。
   */
  photo?: TelegramPhotoSize[];
  voice?: TelegramFileRef;
  video?: TelegramFileRef;
  document?: TelegramFileRef;
  sticker?: TelegramFileRef;
}

/**
 * Webhook 顶层信封：update_id 必有（幂等键 telegram_update_id 取自此值）；
 * 其余内容字段互斥且可选，一条 Update 只出现其一——非 `message` 的内容字段
 * 一律不解析、按忽略策略处理（docs/03），故此处不逐一声明。
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}
