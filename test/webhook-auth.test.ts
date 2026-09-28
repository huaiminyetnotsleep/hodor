import { beforeAll, expect, it } from 'vitest';
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { setUpdateHandler } from '../src/domain';

// docs/10「入口与鉴权」3 条 + 幂等重放 + 判空 payload。
// 存储按文件隔离：本文件自迁移 + 种子一条 bots 行（webhook_secret_hash = SHA-256(测试 Secret)）。
// 本文件只测鉴权/幂等/判空，不测业务链路：S4 起 inbound 槽位为真实处理器（会外呼 Telegram），
// 故注入 no-op 桩（docs/10：处理器注入点仅供 registry 本体与测试使用）。

const db = env.DB;

const SECRET = 'unit-test-webhook-secret';
const WEBHOOK_KEY = 'k-auth-test-bot';
const BOT_TELEGRAM_ID = 4200;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function webhookUrl(key: string = WEBHOOK_KEY): string {
  return `https://example.com/telegram/webhook/${key}`;
}

function webhookPost(options: { key?: string; secret?: string; body: string }): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.secret !== undefined) {
    headers['x-telegram-bot-api-secret-token'] = options.secret;
  }
  return SELF.fetch(webhookUrl(options.key), { method: 'POST', headers, body: options.body });
}

/** 私聊文本 Update（分类 inbound → 已注入的 no-op 桩处理器 → processed） */
function privateUpdateJson(updateId: number): string {
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 555000 + updateId, is_bot: false, first_name: 'User' },
      chat: { id: 555000 + updateId, type: 'private' },
      date: 1760000000,
      text: 'hello hodor',
    },
  });
}

async function inboxCountFor(updateId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM inbox_updates WHERE telegram_update_id = ?')
    .bind(updateId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

async function totalInboxCount(): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM inbox_updates').first<{ n: number }>();
  return row?.n ?? -1;
}

async function auditCount(): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM audit_logs').first<{ n: number }>();
  return row?.n ?? -1;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  setUpdateHandler('inbound', async () => {}); // 业务链路无关本文件（S4 真实处理器会外呼 Telegram）
  const secretHash = await sha256Hex(SECRET);
  await db
    .prepare(
      "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (?, ?, ?, -100999, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind(BOT_TELEGRAM_ID, WEBHOOK_KEY, secretHash)
    .run();
});

it('Secret 缺失 → 401，inbox_updates / audit_logs 零写入（docs/09：401 无业务日志）', async () => {
  const res = await webhookPost({ body: privateUpdateJson(9001) });

  expect(res.status).toBe(401);
  expect(await inboxCountFor(9001)).toBe(0);
  expect(await auditCount()).toBe(0);
});

it('Secret 错误 → 401，零业务写入', async () => {
  const res = await webhookPost({ secret: 'wrong-secret', body: privateUpdateJson(9002) });

  expect(res.status).toBe(401);
  expect(await inboxCountFor(9002)).toBe(0);
  expect(await auditCount()).toBe(0);
});

it('webhook_key 不匹配 → 404（即使 Secret 正确），零业务写入（docs/05：webhook_key 仅混淆不鉴权）', async () => {
  const res = await webhookPost({ key: 'k-no-such-bot', secret: SECRET, body: privateUpdateJson(9003) });

  expect(res.status).toBe(404);
  expect(await inboxCountFor(9003)).toBe(0);
  expect(await auditCount()).toBe(0);
});

it('GET 同路径 → 404（/health 是唯一 GET，docs/05 路由总览）', async () => {
  const res = await SELF.fetch(webhookUrl());
  expect(res.status).toBe(404);
});

it('正确 Secret → 200，Update 幂等登记并处理为 processed', async () => {
  const res = await webhookPost({ secret: SECRET, body: privateUpdateJson(9101) });

  expect(res.status).toBe(200);
  const row = await db
    .prepare(
      'SELECT status, attempts, processed_at, payload_json FROM inbox_updates WHERE bot_id = (SELECT id FROM bots WHERE webhook_key = ?) AND telegram_update_id = ?',
    )
    .bind(WEBHOOK_KEY, 9101)
    .first<{ status: string; attempts: number; processed_at: string | null; payload_json: string }>();
  expect(row).not.toBeNull();
  expect(row?.status).toBe('processed');
  expect(row?.attempts).toBe(0);
  expect(row?.processed_at).not.toBeNull();
  // payload_json 保存原始 Update（docs/06）
  expect(JSON.parse(row?.payload_json ?? '{}')).toHaveProperty('update_id', 9101);
});

it('重放同 payload → 两次均 200，但只登记一次（docs/10 幂等）', async () => {
  const first = await webhookPost({ secret: SECRET, body: privateUpdateJson(9102) });
  const second = await webhookPost({ secret: SECRET, body: privateUpdateJson(9102) });

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM inbox_updates WHERE bot_id = (SELECT id FROM bots WHERE webhook_key = ?) AND telegram_update_id = ?',
    )
    .bind(WEBHOOK_KEY, 9102)
    .first<{ n: number }>();
  expect(row?.n).toBe(1);
});

it('update_id 缺失/非法或非 JSON 的 payload → 静默 200 且零新增登记（docs/03 判空原则）', async () => {
  const before = await totalInboxCount();

  const missingId = await webhookPost({ secret: SECRET, body: JSON.stringify({ message: { text: 'no id' } }) });
  expect(missingId.status).toBe(200);

  const badId = await webhookPost({ secret: SECRET, body: JSON.stringify({ update_id: 'not-a-number' }) });
  expect(badId.status).toBe(200);

  const nonJson = await SELF.fetch(webhookUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: '<html>not json</html>',
  });
  expect(nonJson.status).toBe(200);

  expect(await totalInboxCount()).toBe(before);
});
