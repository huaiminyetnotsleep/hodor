/**
 * inbox · 幂等登记（S3，docs/03「幂等状态机」）。
 *
 * 唯一键 (bot_id, telegram_update_id)：`INSERT … ON CONFLICT DO NOTHING` 后以
 * meta.changes 判新插入——不要先 SELECT 再 INSERT（docs/03 要点，D1 写入串行）。
 * 「登记过」≠「处理过」：是否执行由状态机（process.ts）按 status/attempts 决定。
 */
import type { TelegramUpdate } from '../telegram';

export type InboxStatus = 'pending' | 'processed' | 'failed';

/** inbox_updates 行结构（列唯一来源 = migrations/0001_init.sql） */
export interface InboxUpdateRow {
  id: number;
  bot_id: number;
  telegram_update_id: number;
  payload_json: string;
  status: InboxStatus;
  attempts: number;
  received_at: string;
  processed_at: string | null;
  last_error: string | null;
}

export type RegisterUpdateResult =
  | { status: 'new' }
  | { status: 'duplicate'; row: InboxUpdateRow };

/**
 * 幂等登记一条 Update。
 * - 新 Update：插入 pending 行（payload_json、received_at=ISO 8601 UTC），返回 { status: 'new' }；
 * - 已存在：读回现有行返回 { status: 'duplicate', row }，是否重新执行由状态机决定。
 */
export async function registerUpdate(
  db: D1Database,
  botId: number,
  update: TelegramUpdate,
): Promise<RegisterUpdateResult> {
  const payloadJson = JSON.stringify(update);
  const receivedAt = new Date().toISOString();

  const insert = await db
    .prepare(
      "INSERT INTO inbox_updates (bot_id, telegram_update_id, payload_json, status, received_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT (bot_id, telegram_update_id) DO NOTHING",
    )
    .bind(botId, update.update_id, payloadJson, receivedAt)
    .run();

  if (insert.meta.changes === 1) {
    return { status: 'new' };
  }

  // 冲突 = 收过：读回现有行交给状态机（docs/03）
  const row = await db
    .prepare(
      'SELECT id, bot_id, telegram_update_id, payload_json, status, attempts, received_at, processed_at, last_error FROM inbox_updates WHERE bot_id = ? AND telegram_update_id = ?',
    )
    .bind(botId, update.update_id)
    .first<InboxUpdateRow>();
  if (row === null) {
    // 防御：冲突却读不到行意味着一致性被破坏，按失败上抛 → 5xx 触发重投
    throw new Error(`inbox_updates row missing after conflict: bot=${botId} update=${update.update_id}`);
  }
  return { status: 'duplicate', row };
}
