import { beforeAll, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';

// 每个测试文件的存储相互隔离：本文件先应用 migrations，再种子父行满足 FK
const db = env.DB;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

  // 种子父行：bots id=1；customers id=1/2
  await db.prepare(
    "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (42, 'k-test-bot', 'sha256hex', -100999, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run();
  await db.prepare(
    "INSERT INTO customers (bot_id, telegram_user_id, display_name, created_at, updated_at) VALUES (1, 101, 'Alice', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run();
  await db.prepare(
    "INSERT INTO customers (bot_id, telegram_user_id, display_name, created_at, updated_at) VALUES (1, 102, 'Bob', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run();
});

it('8 张表存在，且 outbox（Phase 2）不建（docs/06）', async () => {
  const res = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  const tables = res.results.map((r) => r.name);

  for (const t of ['bots', 'customers', 'deleted_users', 'conversations', 'support_admins', 'inbox_updates', 'messages', 'audit_logs']) {
    expect(tables).toContain(t);
  }
  expect(tables).not.toContain('outbox');
});

it('5 个次要索引按 docs/06 清单存在', async () => {
  const res = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
    .all<{ name: string }>();
  const names = res.results.map((r) => r.name).sort();

  expect(names).toEqual([
    'idx_audit_bot_time',
    'idx_conversations_customer',
    'idx_conversations_status',
    'idx_inbox_status',
    'idx_messages_conversation',
  ]);
});

it('唯一索引冲突：INSERT … ON CONFLICT DO NOTHING + meta.changes 判新插入（docs/10 数据层）', async () => {
  const insert =
    "INSERT INTO customers (bot_id, telegram_user_id, created_at, updated_at) VALUES (1, 103, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')";

  const first = await db.prepare(`${insert} ON CONFLICT DO NOTHING`).run();
  expect(first.meta.changes).toBe(1);

  const second = await db.prepare(`${insert} ON CONFLICT DO NOTHING`).run();
  expect(second.meta.changes).toBe(0);
});

it('CHECK 约束拒绝非法状态值（状态字典唯一来源，docs/06）', async () => {
  await expect(
    db.prepare(
      "INSERT INTO inbox_updates (bot_id, telegram_update_id, payload_json, status, received_at) VALUES (1, 9001, '{}', 'bogus', '2026-01-01T00:00:00Z')",
    ).run(),
  ).rejects.toThrowError();

  await expect(
    db.prepare(
      "INSERT INTO conversations (bot_id, customer_id, support_chat_id, message_thread_id, status, created_at, updated_at) VALUES (1, 1, -100999, 7, 'blocked', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).run(),
  ).rejects.toThrowError();
});

it('conversations 在 creating 期（message_thread_id 为 NULL）允许多行共存；thread 写回后唯一索引生效', async () => {
  const mk = (customerId: number, thread: number | null) =>
    `INSERT INTO conversations (bot_id, customer_id, support_chat_id, message_thread_id, status, created_at, updated_at)
     VALUES (1, ${customerId}, -100999, ${thread === null ? 'NULL' : thread}, ${thread === null ? "'creating'" : "'open'"}, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;

  await db.prepare(mk(1, null)).run();
  await db.prepare(mk(2, null)).run(); // 双 creating 并存：SQLite 唯一索引视 NULL 互异

  const ok = await db.prepare(mk(1, -1001)).run();
  expect(ok.meta.changes).toBe(1);

  const dup = await db
    .prepare(`${mk(2, -1001)} ON CONFLICT DO NOTHING`)
    .run();
  expect(dup.meta.changes).toBe(0); // (bot, chat, thread) 反向映射唯一（docs/06）
});
