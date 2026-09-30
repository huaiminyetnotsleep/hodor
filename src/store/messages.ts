/**
 * messages 表 store：双向消息账本（T25）。
 *
 * 每条**成功中继**的消息写一行（文本 + 媒体同权）：
 * - direction 'in'：private_msg_id = 用户原始 message_id，group_msg_id = 群内中继消息 ID
 * - direction 'out'：group_msg_id = 管理员原始 message_id，private_msg_id = 私聊中继消息 ID
 *   （管理员消息 ID 完整落库，供阶段 6 /purgemsg 使用）
 * 欢迎语 / 置顶信息 / 无绑定提示等系统类消息**不入账本**（非对话内容）；
 * 中继 permanent 失败（消息被丢弃）同样不写。失败原样抛（→ retryable 路径，
 * 重推可能重发一次中继 = at-least-once 已知代价）。
 */
import { nowIso } from "./util";

/** insertMessage 入参（列名与 docs/guide/database.md 一致） */
export interface NewMessageRow {
  botId: number;
  userId: number;
  threadId: number;
  direction: "in" | "out";
  groupMsgId: number;
  privateMsgId: number;
  /** text / photo / video / voice / document / sticker / animation */
  contentType: string;
}

export async function insertMessage(db: D1Database, row: NewMessageRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages (bot_id, user_id, thread_id, direction, group_msg_id, private_msg_id, content_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.botId,
      row.userId,
      row.threadId,
      row.direction,
      row.groupMsgId,
      row.privateMsgId,
      row.contentType,
      nowIso(),
    )
    .run();
}
