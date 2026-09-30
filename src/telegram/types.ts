/**
 * TelegramResult 三态契约 —— 流水线代码唯一的错误语言
 * （逐字执行 .trellis/spec/backend/error-handling.md）。
 *
 * HTTP/JSON 细节的分类只发生在 src/telegram/client.ts 的 request() 内部；
 * 消费方（pipeline / 路由）永远看不到状态码——只根据 kind 分支。
 * 本文件只定义形状，不含任何分类逻辑。
 */

/** 成功：Telegram 信封 200 + ok:true，result 直接透传 */
export type TelegramOk<T> = { ok: true; result: T };

/**
 * 失败：
 * - retryable —— 网络错误 / 5xx / 非 JSON / 429 等待过久：
 *   让请求失败（5xx），交给 Telegram 重投递 + processed_updates 状态机重试
 * - permanent —— 400（毒丸）/ 403 / 200+ok:false 等：
 *   按数字码分支处理，绝不重试
 */
export type TelegramError = {
  ok: false;
  kind: "retryable" | "permanent";
  /** 概要文本（已消毒：只含方法名 / 状态 / 信封 description，绝不含 token） */
  errorMessage?: string;
  /** 429 场景服务端指示的等待秒数 */
  retryAfterSeconds?: number;
  /** permanent 携带：信封 error_code 或 HTTP 状态码透传，消费方按数字码分支 */
  errorCode?: number;
};

export type TelegramResult<T> = TelegramOk<T> | TelegramError;

/* ------------------------------------------------------------------ */
/* 本阶段（阶段 2 MVP）所需的 6 个 API 方法的入参 / 出参最小类型子集 */
/* ------------------------------------------------------------------ */

/** getMe 返回的 bot 身份（字段按 Telegram User 信封蛇形命名） */
export interface TelegramBotUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

/** setWebhook 入参（方法名驼峰，client 内映射为 secret_token / allowed_updates） */
export interface SetWebhookParams {
  /** webhook 回调地址，= 请求 origin + /webhook（由调用方拼好） */
  url: string;
  /** 注册到 Telegram 的 secret_token（TELEGRAM_WEBHOOK_SECRET） */
  secretToken: string;
  /** 只订阅的 update 类型；阶段 4 验证码回调无需重新绑定 */
  allowedUpdates: string[];
}

/** copyMessage 入参（与 Telegram API 参数一一对应）
 *  （阶段 2 管线已不调用：copyMessage 在生产 bot 上全场景 400
 *  「message to copy not found」，2026-09-30 实测；T22 / 阶段 3 重审媒体路径） */
export interface CopyMessageParams {
  from_chat_id: number;
  from_message_id: number;
  chat_id: number;
  /** 入站带 thread（转发进 topic）；出站私聊不传 */
  message_thread_id?: number;
}

/** copyMessage 出参：新消息 ID */
export interface CopyMessageResult {
  message_id: number;
}

/** sendMessage 入参：阶段 2 文本中继的实际通道 */
export interface SendMessageParams {
  chat_id: number;
  /** 纯文本内容（阶段 2 仅中继 message.text 非空） */
  text: string;
  /** 入站带 thread（送达客服群 topic）；出站私聊不传 */
  message_thread_id?: number;
}

/** sendMessage 出参：新消息 ID */
export interface SendMessageResult {
  message_id: number;
}

/** forwardMessage 入参：注意参数名是 message_id（不是 copyMessage 的 from_message_id）。
 *  转发头承载原发送者身份（「Forwarded from <user>」）——入站中继的指定通道。 */
export interface ForwardMessageParams {
  chat_id: number;
  from_chat_id: number;
  message_id: number;
  /** 入站带 thread（落进客服群对应 topic）；2026-09-30 生产实测支持 */
  message_thread_id?: number;
}

/** forwardMessage 出参：新消息 ID */
export interface ForwardMessageResult {
  message_id: number;
}

/** createForumTopic 入参 */
export interface CreateForumTopicParams {
  chat_id: number;
  /** topic 标题：first_name → @username → ID_<user_id> 三级回退（调用方定死） */
  name: string;
}

/** createForumTopic 出参：新 topic 的 thread ID */
export interface CreateForumTopicResult {
  message_thread_id: number;
}

/** deleteForumTopic 入参 */
export interface DeleteForumTopicParams {
  chat_id: number;
  message_thread_id: number;
}

/** client 工厂返回的方法集（全部经 request() 分类，无一旁路） */
export interface TelegramClient {
  setWebhook(params: SetWebhookParams): Promise<TelegramResult<boolean>>;
  deleteWebhook(): Promise<TelegramResult<boolean>>;
  getMe(): Promise<TelegramResult<TelegramBotUser>>;
  sendMessage(params: SendMessageParams): Promise<TelegramResult<SendMessageResult>>;
  forwardMessage(
    params: ForwardMessageParams,
  ): Promise<TelegramResult<ForwardMessageResult>>;
  copyMessage(params: CopyMessageParams): Promise<TelegramResult<CopyMessageResult>>;
  createForumTopic(
    params: CreateForumTopicParams,
  ): Promise<TelegramResult<CreateForumTopicResult>>;
  deleteForumTopic(params: DeleteForumTopicParams): Promise<TelegramResult<boolean>>;
}
