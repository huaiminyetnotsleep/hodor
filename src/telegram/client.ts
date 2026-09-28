/**
 * telegram · Bot API 客户端（S2，docs/03「Telegram API 错误分类与处理」）。
 *
 * - 错误三态分类唯一判定点：HTTP 细节止于 requestOnce()/request()，pipeline 只见
 *   TelegramResult 三态（成功 / retryable / permanent），永不感知 HTTP；
 * - botToken 与 fetch 均由调用方注入（docs/10：测试打桩，不发真实网络）；
 * - 纯客户端模块：零 D1 依赖、零 pipeline 依赖。
 *
 * 分类决策表（design.md，与 docs/03 一致）：
 *   200 + ok:true            → Ok（透传 result）
 *   200 + ok:false           → permanent（Telegram 业务错，errorMessage = description）
 *   permanent 分支统一透传 envelope 的 error_code 为 errorCode（S5 按 403 判拉黑，不做字符串嗅探）
 *   429, retry_after ≤ 3s    → 等待后原地重试一次；成功→Ok，仍 429→retryable(带 retryAfterSeconds)
 *   429, retry_after > 3s    → retryable(带 retryAfterSeconds)，上抛由重投闭环
 *   429, retry_after 缺失    → 按 >3s 处理（不原地等）
 *   403                      → permanent（errorCode=403，调用方据此走 bot_blocked_by_user）
 *   400                      → permanent（毒丸，不重试；errorMessage 保留供 last_error）
 *   5xx / 网络异常 / 非 JSON → retryable
 *   其他 4xx                 → permanent（缺省保守：不可重试）
 */
import type {
  CloseForumTopicParams,
  CopyMessageParams,
  CreateForumTopicParams,
  DeleteForumTopicParams,
  DeleteWebhookParams,
  EditForumTopicParams,
  GetChatMemberParams,
  ReopenForumTopicParams,
  SendMessageParams,
  SetMyCommandsParams,
  SetWebhookParams,
  TelegramChatMember,
  TelegramError,
  TelegramForumTopic,
  TelegramMessageId,
  TelegramResult,
  TelegramUser,
  TelegramWebhookInfo,
} from './types';

const API_BASE = 'https://api.telegram.org';

/** retry_after ≤ 3s 才原地重试（docs/03：计入本次处理；只重试一次防放大） */
const RETRY_IN_PLACE_MAX_SECONDS = 3;

export interface TelegramClient {
  sendMessage(params: SendMessageParams): Promise<TelegramResult<TelegramMessageId>>;
  copyMessage(params: CopyMessageParams): Promise<TelegramResult<TelegramMessageId>>;
  createForumTopic(params: CreateForumTopicParams): Promise<TelegramResult<TelegramForumTopic>>;
  editForumTopic(params: EditForumTopicParams): Promise<TelegramResult<true>>;
  closeForumTopic(params: CloseForumTopicParams): Promise<TelegramResult<true>>;
  reopenForumTopic(params: ReopenForumTopicParams): Promise<TelegramResult<true>>;
  deleteForumTopic(params: DeleteForumTopicParams): Promise<TelegramResult<true>>;
  setMyCommands(params: SetMyCommandsParams): Promise<TelegramResult<true>>;
  getChatMember(params: GetChatMemberParams): Promise<TelegramResult<TelegramChatMember>>;
  getMe(): Promise<TelegramResult<TelegramUser>>;
  setWebhook(params: SetWebhookParams): Promise<TelegramResult<true>>;
  getWebhookInfo(): Promise<TelegramResult<TelegramWebhookInfo>>;
  deleteWebhook(params: DeleteWebhookParams): Promise<TelegramResult<true>>;
}

/** Bot API 响应信封：只声明分类需要读取的字段，其余不解析 */
interface ApiEnvelope {
  ok?: unknown;
  result?: unknown;
  description?: unknown;
  parameters?: unknown;
  error_code?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readDescription(envelope: ApiEnvelope | undefined): string | undefined {
  const description = envelope?.description;
  return typeof description === 'string' && description.length > 0 ? description : undefined;
}

/** permanent 分支的 error_code 透传（S5 契约决策）；缺失或非法 → undefined（字段不出现在结果里） */
function readErrorCode(envelope: ApiEnvelope | undefined): number | undefined {
  const errorCode = envelope?.error_code;
  return typeof errorCode === 'number' && Number.isFinite(errorCode) ? errorCode : undefined;
}

/** permanent 错误构造单点：description + error_code 透传（errorCode 缺省时不出现在对象里） */
function permanentError(envelope: ApiEnvelope | undefined, fallbackMessage: string): TelegramError {
  const errorCode = readErrorCode(envelope);
  return {
    ok: false,
    kind: 'permanent',
    ...(errorCode !== undefined && { errorCode }),
    errorMessage: readDescription(envelope) ?? fallbackMessage,
  };
}

/** 429 的 parameters.retry_after；缺失或非法 → undefined（调用方按 >3s 处理，design.md） */
function readRetryAfterSeconds(envelope: ApiEnvelope | undefined): number | undefined {
  const parameters = asRecord(envelope?.parameters);
  const retryAfter = parameters?.retry_after;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : undefined;
}

/** 丢弃值为 undefined 的字段：可选参数不出现在请求体里（与 Bot API 缺省语义一致） */
function compactBody(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTelegramClient(options: { botToken: string; fetchImpl?: typeof fetch }): TelegramClient {
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
  const botToken = options.botToken;

  /** 单次请求 + 全量分类（不含 429 重试策略，重试收敛在 request()） */
  async function requestOnce<T>(method: string, payload: Record<string, unknown>): Promise<TelegramResult<T>> {
    const url = `${API_BASE}/bot${botToken}/${method}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // 网络异常 / 超时（表现为异常）→ 可重试（docs/03）
      return {
        ok: false,
        kind: 'retryable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const status = response.status;
    let envelope: ApiEnvelope | undefined;
    try {
      envelope = asRecord(JSON.parse(await response.text()));
    } catch {
      // 非 JSON 响应体：envelope 置空，按状态码分类（200 场景 → retryable）
      envelope = undefined;
    }

    if (status === 200) {
      if (envelope === undefined) {
        return { ok: false, kind: 'retryable', errorMessage: 'non-JSON response body' };
      }
      if (envelope.ok === true) {
        return { ok: true, result: envelope.result as T };
      }
      if (envelope.ok === false) {
        // Telegram 业务错（chat not found 等）→ permanent（200 信封的 error_code 同样透传）
        return permanentError(envelope, 'unknown Telegram error');
      }
      // ok 字段缺失/非法：无法确认成功，保守按可重试
      return { ok: false, kind: 'retryable', errorMessage: 'unexpected response shape' };
    }

    if (status === 429) {
      const retryAfterSeconds = readRetryAfterSeconds(envelope);
      return { ok: false, kind: 'retryable', retryAfterSeconds, errorMessage: readDescription(envelope) };
    }

    if (status >= 500) {
      return { ok: false, kind: 'retryable', errorMessage: readDescription(envelope) ?? `HTTP ${status}` };
    }

    // 400（毒丸）/ 403（用户拉黑）/ 其他 4xx → permanent（缺省保守不可重试）
    return permanentError(envelope, `HTTP ${status}`);
  }

  /** 请求入口：429 原地重试策略唯一落点（retry_after ≤ 3s 等待后重试一次，只一次） */
  async function request<T>(method: string, payload: Record<string, unknown>): Promise<TelegramResult<T>> {
    const first = await requestOnce<T>(method, payload);
    if (first.ok || first.kind !== 'retryable') return first;
    const { retryAfterSeconds } = first;
    if (retryAfterSeconds === undefined || retryAfterSeconds > RETRY_IN_PLACE_MAX_SECONDS) return first;
    await sleep(retryAfterSeconds * 1000);
    return requestOnce<T>(method, payload);
  }

  return {
    sendMessage: (params) =>
      request<TelegramMessageId>(
        'sendMessage',
        compactBody({
          chat_id: params.chatId,
          text: params.text,
          message_thread_id: params.messageThreadId,
        }),
      ),

    copyMessage: (params) =>
      request<TelegramMessageId>(
        'copyMessage',
        compactBody({
          chat_id: params.chatId,
          from_chat_id: params.fromChatId,
          message_id: params.messageId,
          message_thread_id: params.messageThreadId,
        }),
      ),

    createForumTopic: (params) =>
      request<TelegramForumTopic>(
        'createForumTopic',
        compactBody({
          chat_id: params.chatId,
          name: params.name,
          icon_color: params.iconColor,
          icon_custom_emoji_id: params.iconCustomEmojiId,
        }),
      ),

    editForumTopic: (params) =>
      request<true>(
        'editForumTopic',
        compactBody({
          chat_id: params.chatId,
          message_thread_id: params.messageThreadId,
          name: params.name,
          icon_custom_emoji_id: params.iconCustomEmojiId,
        }),
      ),

    closeForumTopic: (params) =>
      request<true>('closeForumTopic', {
        chat_id: params.chatId,
        message_thread_id: params.messageThreadId,
      }),

    reopenForumTopic: (params) =>
      request<true>('reopenForumTopic', {
        chat_id: params.chatId,
        message_thread_id: params.messageThreadId,
      }),

    deleteForumTopic: (params) =>
      request<true>('deleteForumTopic', {
        chat_id: params.chatId,
        message_thread_id: params.messageThreadId,
      }),

    setMyCommands: (params) => request<true>('setMyCommands', { commands: params.commands }),

    getChatMember: (params) =>
      request<TelegramChatMember>('getChatMember', {
        chat_id: params.chatId,
        user_id: params.userId,
      }),

    getMe: () => request<TelegramUser>('getMe', {}),

    setWebhook: (params) =>
      request<true>(
        'setWebhook',
        compactBody({
          url: params.url,
          secret_token: params.secretToken,
          allowed_updates: params.allowedUpdates,
          drop_pending_updates: params.dropPendingUpdates,
        }),
      ),

    getWebhookInfo: () => request<TelegramWebhookInfo>('getWebhookInfo', {}),

    deleteWebhook: (params) =>
      request<true>('deleteWebhook', compactBody({ drop_pending_updates: params.dropPendingUpdates })),
  };
}
