/**
 * store · messages 表访问与内容提取（S4，docs/03「Update 结构速查」/docs/06）。
 * 列清单唯一来源 = migrations/0001_init.sql；行结构在此声明一次，消费方经 `../store` 引用。
 *
 * 内容提取按 docs/03 判空原则：内容字段全部可选，不得假定 text 存在；
 * 媒体不解析本体，只取 file_id（photo 取最高分辨率项；document/voice/video 取各自 file_id）。
 */
import type { TelegramMessage, TelegramPhotoSize } from '../telegram';

export type MessageDirection = 'inbound' | 'outbound';

/** Phase 1 content_type 字典（docs/03：text / photo / voice / document / …；未声明媒体回落 text） */
export type MessageContentType = 'text' | 'photo' | 'voice' | 'video' | 'document' | 'sticker';

export interface MessageRow {
  id: number;
  conversation_id: number;
  direction: MessageDirection;
  source_chat_id: number | null;
  source_message_id: number | null;
  target_chat_id: number | null;
  target_message_id: number | null;
  message_thread_id: number | null;
  content_type: string;
  text_content: string | null;
  media_file_id: string | null;
  r2_object_key: string | null;
  created_at: string;
}

/** 按互斥媒体字段推断 content_type（docs/03 速查：一条 Update 只出现一个内容字段） */
export function inferContentType(message: TelegramMessage): MessageContentType {
  if (message.photo !== undefined) return 'photo';
  if (message.voice !== undefined) return 'voice';
  if (message.video !== undefined) return 'video';
  if (message.document !== undefined) return 'document';
  if (message.sticker !== undefined) return 'sticker';
  return 'text';
}

/** 落库文本：text 或 caption（检索用），两者皆缺 → null */
export function extractTextContent(message: TelegramMessage): string | null {
  return message.text ?? message.caption ?? null;
}

/**
 * media_file_id（docs/07：Telegram 媒体主存引用，可重发）：
 * photo 取最高分辨率项（按 width*height，并列取后者）；document/voice/video 取各自 file_id；
 * 其余（含 sticker，无重发诉求）→ null。
 */
export function extractMediaFileId(message: TelegramMessage): string | null {
  const photo = message.photo;
  if (photo !== undefined) {
    let best: TelegramPhotoSize | undefined;
    for (const size of photo) {
      if (best === undefined || size.width * size.height >= best.width * best.height) {
        best = size;
      }
    }
    if (best !== undefined) return best.file_id;
  }
  return message.document?.file_id ?? message.voice?.file_id ?? message.video?.file_id ?? null;
}

export interface RecordMessageInput {
  conversationId: number;
  direction: MessageDirection;
  /** 复制源坐标（入站 = 用户私聊；出站 = 群 Topic） */
  sourceChatId: number;
  sourceMessageId: number;
  /** 复制目标坐标（copyMessage 返回的新 message_id） */
  targetChatId: number;
  targetMessageId: number;
  /** 冗余 Topic ID（docs/06） */
  messageThreadId: number;
  /** 内容提取源：content_type / text_content / media_file_id 按上面三个纯函数推断 */
  message: TelegramMessage;
}

/** 中继记录落库（docs/03 步骤 10；入站 S4 消费，出站 S5 复用） */
export async function recordMessage(db: D1Database, input: RecordMessageInput): Promise<void> {
  await db
    .prepare(
      'INSERT INTO messages (conversation_id, direction, source_chat_id, source_message_id, target_chat_id, target_message_id, message_thread_id, content_type, text_content, media_file_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      input.conversationId,
      input.direction,
      input.sourceChatId,
      input.sourceMessageId,
      input.targetChatId,
      input.targetMessageId,
      input.messageThreadId,
      inferContentType(input.message),
      extractTextContent(input.message),
      extractMediaFileId(input.message),
      new Date().toISOString(), // 全局约定：ISO 8601 UTC（migrations/0001 头注）
    )
    .run();
}
