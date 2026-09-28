/**
 * store · support_admins 表访问（S5，docs/06 管理员白名单）。
 * 列清单唯一来源 = migrations/0001_init.sql；行结构在此声明一次，消费方经 `../store` 引用。
 */

export interface SupportAdmin {
  id: number;
  bot_id: number;
  telegram_user_id: number;
  display_name: string | null;
  created_at: string;
}

/**
 * 出站白名单校验原语（docs/03 出站链路校验 ③）：
 * 按 (bot_id, telegram_user_id) 查管理员；查无返回 undefined（调用方静默忽略，docs/03）。
 */
export async function findByBotAndUser(
  db: D1Database,
  botId: number,
  telegramUserId: number,
): Promise<SupportAdmin | undefined> {
  const row = await db
    .prepare('SELECT id, bot_id, telegram_user_id, display_name, created_at FROM support_admins WHERE bot_id = ? AND telegram_user_id = ?')
    .bind(botId, telegramUserId)
    .first<SupportAdmin>();
  return row ?? undefined;
}

/**
 * 白名单写入原语（S9，docs/05「管理员白名单」：每次变更写 audit_logs，审计由调用方负责）。
 * INSERT … ON CONFLICT DO NOTHING：缺则增、不删除（setup 语义），已存在返回 false。
 */
export async function addSupportAdmin(
  db: D1Database,
  botId: number,
  telegramUserId: number,
  displayName?: string,
): Promise<boolean> {
  const insert = await db
    .prepare('INSERT INTO support_admins (bot_id, telegram_user_id, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (bot_id, telegram_user_id) DO NOTHING')
    .bind(botId, telegramUserId, displayName ?? null, new Date().toISOString())
    .run();
  return insert.meta.changes === 1;
}

/**
 * 白名单批量删除原语（S9 /admin/admins action=remove）。返回实际删除行数；
 * 空列表直接返回 0（不拼 SQL）。不设保留下限（docs/05 未约束，design.md 定稿）。
 */
export async function removeSupportAdmins(db: D1Database, botId: number, telegramUserIds: readonly number[]): Promise<number> {
  if (telegramUserIds.length === 0) {
    return 0;
  }
  const placeholders = telegramUserIds.map(() => '?').join(', ');
  const res = await db
    .prepare(`DELETE FROM support_admins WHERE bot_id = ? AND telegram_user_id IN (${placeholders})`)
    .bind(botId, ...telegramUserIds)
    .run();
  return res.meta.changes;
}
