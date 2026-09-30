/**
 * users 表 store：用户建档与展示缓存刷新。
 *
 * T19：首条私聊文本即建档（无需 /start）；每次消息刷新昵称缓存与 last_seen_at。
 * upsert 只覆盖「创建侧无关」的列：
 * - first_name / last_name / username —— 昵称缓存，随消息刷新
 * - last_seen_at —— 最近活跃时间
 * first_seen_at（首次建档时间）、status / is_banned 等治理列一概不动。
 */
import { nowIso } from "./util";

/** Telegram update 里 from 的展示字段子集（缺省字段归一为空串） */
export interface UserFromFields {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * 建档 / 刷新用户行：冲突时只更新昵称缓存与 last_seen_at。
 * 首次插入的 first_seen_at / status / is_banned 走列默认值，永不被覆盖。
 */
export async function ensureUser(
  db: D1Database,
  botId: number,
  from: UserFromFields,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (bot_id, user_id, first_name, last_name, username, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, user_id) DO UPDATE SET
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         username = excluded.username,
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(
      botId,
      from.id,
      from.first_name ?? "",
      from.last_name ?? "",
      from.username ?? "",
      nowIso(),
    )
    .run();
}
