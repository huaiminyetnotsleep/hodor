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
 * 白名单的增删由 S9 管理端点负责，本模块只读。
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
