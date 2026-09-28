/**
 * store · customers / deleted_users 表访问（S4，docs/06）。
 * 列清单唯一来源 = migrations/0001_init.sql；行结构在此声明一次，消费方经 `../store` 引用。
 *
 * 墓碑语义独立成组（findTombstone / deleteTombstone / createTombstone），不与客户查询 JOIN——
 * 「客户不存在」与「客户曾被删除」是入站链路的两个不同分支（docs/03 入站步骤 4）。
 */

export interface Customer {
  id: number;
  bot_id: number;
  telegram_user_id: number;
  display_name: string | null;
  username: string | null;
  /** 0/1；封禁唯一事实源（docs/04，S6 消费） */
  blocked: number;
  /** 0/1；用户拉黑 Bot 标志（docs/03） */
  bot_blocked_by_user: number;
  /** 0/1；高危名单唯一事实源（docs/04，S6 消费） */
  watchlisted: number;
  last_watch_notice_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS =
  'id, bot_id, telegram_user_id, display_name, username, blocked, bot_blocked_by_user, watchlisted, last_watch_notice_at, created_at, updated_at';

function nowIso(): string {
  return new Date().toISOString(); // 全局约定：ISO 8601 UTC（migrations/0001 头注）
}

/** 按 (bot_id, telegram_user_id) 查客户；查无返回 undefined（调用方继续走墓碑/未知用户分支） */
export async function findByTelegramId(
  db: D1Database,
  botId: number,
  telegramUserId: number,
): Promise<Customer | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM customers WHERE bot_id = ? AND telegram_user_id = ?`)
    .bind(botId, telegramUserId)
    .first<Customer>();
  return row ?? undefined;
}

export interface UpsertCustomerInput {
  botId: number;
  telegramUserId: number;
  displayName: string;
  username: string | null;
  /** 仅新建时生效：/start 复活继承墓碑 was_watchlisted（docs/03 步骤 4）；缺省 false */
  watchlisted?: boolean;
}

export interface UpsertCustomerResult {
  customer: Customer;
  /** true = 本次新建（新 #序号；驱动 WELCOME，docs/03 步骤 11/design.md 语义 7） */
  isNew: boolean;
}

/**
 * 查/建客户：`INSERT … ON CONFLICT DO NOTHING` 后以 meta.changes 判新插入，
 * 不先 SELECT 再 INSERT（docs/03 要点，D1 写入串行）；冲突时读回既有行原样返回，
 * 不在此更新档案——改名/换 username 的刷新由 updateCustomerProfile 单独负责（design.md 语义 8）。
 */
export async function upsertCustomer(db: D1Database, input: UpsertCustomerInput): Promise<UpsertCustomerResult> {
  const now = nowIso();
  const insert = await db
    .prepare(
      'INSERT INTO customers (bot_id, telegram_user_id, display_name, username, watchlisted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (bot_id, telegram_user_id) DO NOTHING',
    )
    .bind(input.botId, input.telegramUserId, input.displayName, input.username, input.watchlisted === true ? 1 : 0, now, now)
    .run();

  const customer = await findByTelegramId(db, input.botId, input.telegramUserId);
  if (customer === undefined) {
    // 防御：插入/冲突后读不到行意味着一致性被破坏，按失败上抛 → inbox 5xx 重投
    throw new Error(`customers row missing after upsert: bot=${input.botId} telegram_user_id=${input.telegramUserId}`);
  }
  return { customer, isNew: insert.meta.changes === 1 };
}

/** 档案刷新（docs/03 步骤 8：display_name/username 与库中不一致时更新） */
export async function updateCustomerProfile(
  db: D1Database,
  customerId: number,
  displayName: string,
  username: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE customers SET display_name = ?, username = ?, updated_at = ? WHERE id = ?')
    .bind(displayName, username, nowIso(), customerId)
    .run();
}

/** bot_blocked_by_user 标志读写（入站复位 false=用户回归 docs/03；置 true 由 S5 403 处理） */
export async function setBotBlockedByUser(db: D1Database, customerId: number, blocked: boolean): Promise<void> {
  await db
    .prepare('UPDATE customers SET bot_blocked_by_user = ?, updated_at = ? WHERE id = ?')
    .bind(blocked ? 1 : 0, nowIso(), customerId)
    .run();
}

/**
 * blocked 标志写入（S6 /ban /unban，docs/04「状态唯一来源」）：封禁语义的唯一写入点——
 * conversations.status 不承载封禁（CHECK 已约束），入站/出站拒绝路径只读本标志。
 */
export async function setBlocked(db: D1Database, customerId: number, blocked: boolean): Promise<void> {
  await db
    .prepare('UPDATE customers SET blocked = ?, updated_at = ? WHERE id = ?')
    .bind(blocked ? 1 : 0, nowIso(), customerId)
    .run();
}

/**
 * watchlisted 标志写入（S7 /risk /unrisk，docs/04「状态唯一来源」）：高危名单的唯一写入点——
 * 与 blocked 正交独立（docs/04「正交独立」：/risk 不改 blocked、/ban /unban 不改本标志，
 * 可叠加；标题 🔇/⚠️ 是两标志的纯派生展示，docs/02）。
 */
export async function setWatchlisted(db: D1Database, customerId: number, watchlisted: boolean): Promise<void> {
  await db
    .prepare('UPDATE customers SET watchlisted = ?, updated_at = ? WHERE id = ?')
    .bind(watchlisted ? 1 : 0, nowIso(), customerId)
    .run();
}

/**
 * last_watch_notice_at 刷新（S7 入站 WATCH_NOTICE 24h 限频，docs/03 入站步骤 11 / docs/04）：
 * 仅在 WATCH_NOTICE 发送成功后调用——时间戳即「上次提示」的唯一事实源，
 * 发送失败不刷新，让下一次入站自然重试（避免 24h 静默吞掉失败的提示）。
 */
export async function setLastWatchNoticeAt(db: D1Database, customerId: number, noticedAtIso: string): Promise<void> {
  await db
    .prepare('UPDATE customers SET last_watch_notice_at = ?, updated_at = ? WHERE id = ?')
    .bind(noticedAtIso, nowIso(), customerId)
    .run();
}

// ── deleted_users 墓碑（docs/04 /deluser 语义；S4 消费 find/delete，S6 消费 create）──

export interface DeletedUserTombstone {
  id: number;
  bot_id: number;
  telegram_user_id: number;
  /** /start 重建时继承（docs/03 步骤 4） */
  was_watchlisted: number;
  deleted_at: string;
  deleted_by: number | null;
}

const TOMBSTONE_COLUMNS = 'id, bot_id, telegram_user_id, was_watchlisted, deleted_at, deleted_by';

export async function findTombstone(
  db: D1Database,
  botId: number,
  telegramUserId: number,
): Promise<DeletedUserTombstone | undefined> {
  const row = await db
    .prepare(`SELECT ${TOMBSTONE_COLUMNS} FROM deleted_users WHERE bot_id = ? AND telegram_user_id = ?`)
    .bind(botId, telegramUserId)
    .first<DeletedUserTombstone>();
  return row ?? undefined;
}

/** 删除墓碑（仅 /start 复活路径调用，docs/03 步骤 4） */
export async function deleteTombstone(db: D1Database, botId: number, telegramUserId: number): Promise<void> {
  await db.prepare('DELETE FROM deleted_users WHERE bot_id = ? AND telegram_user_id = ?').bind(botId, telegramUserId).run();
}

export interface CreateTombstoneInput {
  botId: number;
  telegramUserId: number;
  /** 继承自被删客户当时的 watchlisted（docs/04：墓碑不含内容数据，只留此标志） */
  wasWatchlisted: boolean;
  /** 执行删除的管理员 telegram_user_id（docs/06）；系统操作省略 */
  deletedBy?: number;
}

/** 写墓碑（S6 /deluser 消费；重复删除幂等——ON CONFLICT DO NOTHING 保留首条） */
export async function createTombstone(db: D1Database, input: CreateTombstoneInput): Promise<void> {
  await db
    .prepare(
      'INSERT INTO deleted_users (bot_id, telegram_user_id, was_watchlisted, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (bot_id, telegram_user_id) DO NOTHING',
    )
    .bind(input.botId, input.telegramUserId, input.wasWatchlisted ? 1 : 0, nowIso(), input.deletedBy ?? null)
    .run();
}
