import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { createStubFetch, type TelegramCall } from './telegram-stub';
import { resetRateLimitForTests } from '../src/store/ratelimit';

// S9 管理端点（docs/05「管理端点与初始化绑定」、design.md 11 用例）。
// 存储按文件隔离：本文件自迁移。Telegram 走全局 fetch 桩（SELF.fetch 全链路：main worker
// 与测试同 isolate，全局 mock 生效），限速为 isolate 级内存态——beforeEach 重置隔离；
// 429 用例另用专属 IP 头，不污染其他用例的 'unknown' 键。
// 请求 Host 用 https://test.example.com，setup 的 setWebhook url 断言依赖它。

const db = env.DB;

interface BotRow {
  id: number;
  telegram_bot_id: number;
  webhook_key: string;
  webhook_secret_hash: string;
  support_chat_id: number;
  status: string;
  config_version: number;
}

interface AuditRow {
  actor_type: string;
  actor_id: number | null;
  detail_json: string | null;
}

interface SupportAdminRow {
  telegram_user_id: number;
  display_name: string | null;
}

function meResult(botId: number): Record<string, unknown> {
  return { id: botId, is_bot: true, first_name: 'TestBot', username: 'test_bot' };
}

function webhookInfoResult(url: string): Record<string, unknown> {
  return { url, has_custom_certificate: false, pending_update_count: 0 };
}

/** 用 vi.stubGlobal 打全局 fetch 桩；afterEach 统一 unstubAllGlobals 还原 */
function stubTelegram(handlers: Parameters<typeof createStubFetch>[0]): { calls: TelegramCall[] } {
  const { fetchImpl, calls } = createStubFetch(handlers);
  vi.stubGlobal('fetch', fetchImpl);
  return { calls };
}

function adminPost(path: string, options: { token?: string; ip?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['authorization'] = `Bearer ${options.token}`;
  }
  if (options.ip !== undefined) {
    headers['cf-connecting-ip'] = options.ip;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return SELF.fetch(`https://test.example.com${path}`, { method: 'POST', headers, body });
}

async function countRows(table: 'bots' | 'audit_logs' | 'support_admins'): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? -1;
}

/** 直接 seed 一条 bots 行（unbind/admins 用例需要已初始化的 bot；hash 与 env Secret 同源） */
async function seedBot(telegramBotId: number, webhookKey: string, secretHash: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (?, ?, ?, -1001234567890, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z') ON CONFLICT (telegram_bot_id) DO NOTHING",
    )
    .bind(telegramBotId, webhookKey, secretHash)
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => {
  resetRateLimitForTests(); // 限速是 isolate 级内存态，用例间必须重置
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ① 401：无/错 Bearer，零副作用（docs/09：失败 401 不做业务处理、不留业务日志）
it('无/错 Bearer → 401，bots / audit_logs 零写入', async () => {
  const botsBefore = await countRows('bots');
  const auditBefore = await countRows('audit_logs');

  const missing = await adminPost('/admin/setup');
  expect(missing.status).toBe(401);
  const wrong = await adminPost('/admin/setup', { token: 'wrong-admin-secret' });
  expect(wrong.status).toBe(401);

  expect(await countRows('bots')).toBe(botsBefore);
  expect(await countRows('audit_logs')).toBe(auditBefore);
});

// ② 限速：同 IP 窗口超上限 → 429；未授权尝试同样占窗口；不同 IP 键独立
it('同一 IP 超过窗口上限 → 429；其他 IP 不受影响', async () => {
  const ip = '203.0.113.9';
  for (let i = 0; i < 10; i += 1) {
    const res = await adminPost('/admin/setup', { ip });
    expect(res.status).toBe(401); // 上限内：鉴权失败仍为 401
  }
  const limited = await adminPost('/admin/setup', { ip });
  expect(limited.status).toBe(429);

  const otherIp = await adminPost('/admin/setup', { ip: '203.0.113.10' });
  expect(otherIp.status).toBe(401); // 独立键：不受前一 IP 影响
});

// ③ setup 全链路：getMe → seed → 白名单 → setWebhook 参数断言 → setMyCommands → 核对 → 审计
it('setup 全链路：seed bots 行、白名单、setWebhook url/secret/allowed_updates、audit webhook_bind', async () => {
  const { calls } = stubTelegram({
    getMe: () => meResult(4242),
    setWebhook: () => true,
    setMyCommands: () => true,
    getWebhookInfo: () => webhookInfoResult('https://test.example.com/telegram/webhook/PLACEHOLDER'),
  });

  const res = await adminPost('/admin/setup', {
    token: env.ADMIN_SETUP_SECRET,
    body: { support_chat_id: -1001234567890, admin_ids: [111, 222] },
  });

  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; bot_id: number; webhook_key: string; webhook: unknown };
  expect(json.ok).toBe(true);
  expect(json.bot_id).toBe(4242);
  expect(json.webhook_key).toMatch(/^[0-9a-f]{16}$/);

  // 调用序列与 setWebhook 参数（url 从请求 Host 推导；secret 为 env 原文）
  expect(calls.map((call) => call.method)).toEqual(['getMe', 'setWebhook', 'setMyCommands', 'getWebhookInfo']);
  const setWebhook = calls.find((call) => call.method === 'setWebhook');
  expect(setWebhook?.payload).toMatchObject({
    url: `https://test.example.com/telegram/webhook/${json.webhook_key}`,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message'],
  });

  // setMyCommands：群级 scope + 6 条命令（docs/04）
  const commands = calls.find((call) => call.method === 'setMyCommands');
  expect(commands?.payload).toMatchObject({ scope: { type: 'chat', chat_id: -1001234567890 } });
  expect((commands?.payload['commands'] as unknown[]).length).toBe(6);

  // bots 行 seed
  const bot = await db.prepare('SELECT id, telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, status, config_version FROM bots WHERE telegram_bot_id = ?').bind(4242).first<BotRow>();
  expect(bot).not.toBeNull();
  expect(bot?.webhook_key).toBe(json.webhook_key);
  const expectedHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET));
  const expectedHashHex = Array.from(new Uint8Array(expectedHash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  expect(bot?.webhook_secret_hash).toBe(expectedHashHex);
  expect(bot?.support_chat_id).toBe(-1001234567890);
  expect(bot?.status).toBe('active');
  expect(bot?.config_version).toBe(1);

  // 白名单 upsert
  const admins = await db.prepare('SELECT telegram_user_id, display_name FROM support_admins WHERE bot_id = ? ORDER BY telegram_user_id').bind(bot?.id).all<SupportAdminRow>();
  expect(admins.results.map((row) => row.telegram_user_id)).toEqual([111, 222]);

  // audit webhook_bind：system 操作者；detail 只含上下文，绝无 Secret 值
  const audit = await db.prepare("SELECT actor_type, actor_id, detail_json FROM audit_logs WHERE action = 'webhook_bind'").first<AuditRow>();
  expect(audit).not.toBeNull();
  expect(audit?.actor_type).toBe('system');
  expect(audit?.actor_id).toBeNull();
  const detail = JSON.parse(audit?.detail_json ?? '{}') as Record<string, unknown>;
  expect(detail).toMatchObject({ bot_id: 4242, webhook_key: json.webhook_key, support_chat_id: -1001234567890, admin_count: 2 });
  expect(JSON.stringify(detail)).not.toContain(env.TELEGRAM_WEBHOOK_SECRET);
});

// ④ 空请求体回退 env（SUPPORT_CHAT_ID / ADMIN_IDS 逗号分隔）
it('setup 空请求体 → 回退 env 的 SUPPORT_CHAT_ID / ADMIN_IDS', async () => {
  stubTelegram({
    getMe: () => meResult(4243),
    setWebhook: () => true,
    setMyCommands: () => true,
    getWebhookInfo: () => webhookInfoResult('https://test.example.com/telegram/webhook/PLACEHOLDER'),
  });

  const res = await adminPost('/admin/setup', { token: env.ADMIN_SETUP_SECRET });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; bot_id: number };
  expect(json.bot_id).toBe(4243);

  const bot = await db.prepare('SELECT id, support_chat_id FROM bots WHERE telegram_bot_id = ?').bind(4243).first<BotRow>();
  expect(bot?.support_chat_id).toBe(Number(env.SUPPORT_CHAT_ID));
  const admins = await db.prepare('SELECT telegram_user_id FROM support_admins WHERE bot_id = ? ORDER BY telegram_user_id').bind(bot?.id).all<SupportAdminRow>();
  const expectedIds = env.ADMIN_IDS.split(',').map((part) => Number(part.trim())).sort((a, b) => a - b);
  expect(admins.results.map((row) => row.telegram_user_id)).toEqual(expectedIds);
});

// ⑤ 重复 setup 幂等：bots 行不重复、webhook_key 稳定、白名单不删（docs/05 upsert 语义）
it('setup 重复调用幂等：webhook_key 稳定、bots 行唯一、白名单不删', async () => {
  stubTelegram({
    getMe: () => meResult(4244),
    setWebhook: () => true,
    setMyCommands: () => true,
    getWebhookInfo: () => webhookInfoResult('https://test.example.com/telegram/webhook/PLACEHOLDER'),
  });

  const first = await adminPost('/admin/setup', {
    token: env.ADMIN_SETUP_SECRET,
    body: { support_chat_id: -1001234567890, admin_ids: [333, 444] },
  });
  const second = await adminPost('/admin/setup', {
    token: env.ADMIN_SETUP_SECRET,
    body: { support_chat_id: -1001234567890, admin_ids: [333, 444] },
  });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const firstJson = (await first.json()) as { webhook_key: string };
  const secondJson = (await second.json()) as { webhook_key: string };

  // bots 行唯一且 webhook_key 不变（Webhook URL 长期稳定，docs/05）
  const rows = await db.prepare('SELECT id, webhook_key, config_version FROM bots WHERE telegram_bot_id = ?').bind(4244).all<BotRow>();
  expect(rows.results.length).toBe(1);
  expect(rows.results[0]?.webhook_key).toBe(firstJson.webhook_key);
  expect(secondJson.webhook_key).toBe(firstJson.webhook_key);
  expect(rows.results[0]?.config_version).toBe(2); // 代数递增

  // 白名单不删除：仍为两行
  const adminCount = await db.prepare('SELECT COUNT(*) AS n FROM support_admins WHERE bot_id = ?').bind(rows.results[0]?.id).first<{ n: number }>();
  expect(adminCount?.n).toBe(2);

  // 两次绑定各写一条审计（按 bot_id 限定——其他用例也在本文件共享库里写过 webhook_bind）
  const auditCount = await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'webhook_bind' AND bot_id = ?").bind(rows.results[0]?.id).first<{ n: number }>();
  expect(auditCount?.n).toBe(2);
});

// ⑥ setMyCommands 失败非致命：audit 带 last_error，绑定不阻断（docs/04）
it('setMyCommands 失败 → setup 仍成功，audit 带 set_my_commands_error', async () => {
  stubTelegram({
    getMe: () => meResult(4245),
    setWebhook: () => true,
    setMyCommands: () => ({ status: 500, body: { ok: false, description: 'internal server error' } }),
    getWebhookInfo: () => webhookInfoResult('https://test.example.com/telegram/webhook/PLACEHOLDER'),
  });

  const res = await adminPost('/admin/setup', {
    token: env.ADMIN_SETUP_SECRET,
    body: { support_chat_id: -1001234567890, admin_ids: [111] },
  });

  expect(res.status).toBe(200);
  const bot = await db.prepare('SELECT id FROM bots WHERE telegram_bot_id = ?').bind(4245).first<BotRow>();
  expect(bot).not.toBeNull();
  const audit = await db.prepare("SELECT detail_json FROM audit_logs WHERE action = 'webhook_bind' AND bot_id = ? ORDER BY id DESC").bind(bot?.id).first<AuditRow>();
  const detail = JSON.parse(audit?.detail_json ?? '{}') as { set_my_commands_error?: string };
  expect(detail.set_my_commands_error).toContain('internal server error');
});

// ⑦ getMe 失败中止：不落库（retryable 与 permanent 都 → 502）
it('getMe 失败（retryable/permanent）→ 502，bots / audit_logs 零写入', async () => {
  const botsBefore = await countRows('bots');
  const auditBefore = await countRows('audit_logs');

  stubTelegram({
    getMe: () => ({ status: 500, body: { ok: false, description: 'internal server error' } }), // retryable
  });
  const retryable = await adminPost('/admin/setup', { token: env.ADMIN_SETUP_SECRET });
  expect(retryable.status).toBe(502);

  stubTelegram({
    getMe: () => ({ status: 401, body: { ok: false, description: 'Unauthorized' } }), // permanent（毒 Token）
  });
  const permanent = await adminPost('/admin/setup', { token: env.ADMIN_SETUP_SECRET });
  expect(permanent.status).toBe(502);

  expect(await countRows('bots')).toBe(botsBefore);
  expect(await countRows('audit_logs')).toBe(auditBefore);
});

// ⑧ status：getWebhookInfo 透传，纯透传不碰 D1（仅一次 Telegram 调用）
it('webhook/status → getWebhookInfo 结果原样透出', async () => {
  const info = webhookInfoResult('https://test.example.com/telegram/webhook/PLACEHOLDER');
  const { calls } = stubTelegram({ getWebhookInfo: () => info });

  const res = await adminPost('/admin/webhook/status', { token: env.ADMIN_SETUP_SECRET });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, webhook: info });
  expect(calls.map((call) => call.method)).toEqual(['getWebhookInfo']);
});

// ⑨ unbind：drop_pending_updates 缺省 false（保留积压）+ audit webhook_unbind
it('webhook/unbind：缺省 drop_pending_updates=false，显式 true 可传，写审计', async () => {
  await seedBot(4250, 'k-admin-unbind', '');
  const { calls } = stubTelegram({
    getMe: () => meResult(4250),
    deleteWebhook: () => true,
  });

  const first = await adminPost('/admin/webhook/unbind', { token: env.ADMIN_SETUP_SECRET });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, drop_pending_updates: false });
  expect(calls.find((call) => call.method === 'deleteWebhook')?.payload).toEqual({ drop_pending_updates: false });

  const second = await adminPost('/admin/webhook/unbind', {
    token: env.ADMIN_SETUP_SECRET,
    body: { drop_pending_updates: true },
  });
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ ok: true, drop_pending_updates: true });
  expect(calls.filter((call) => call.method === 'deleteWebhook')[1]?.payload).toEqual({ drop_pending_updates: true });

  const audit = await db.prepare("SELECT actor_type, detail_json FROM audit_logs WHERE action = 'webhook_unbind' ORDER BY id DESC").first<AuditRow>();
  expect(audit?.actor_type).toBe('system');
  const detail = JSON.parse(audit?.detail_json ?? '{}') as Record<string, unknown>;
  expect(detail).toMatchObject({ telegram_bot_id: 4250, drop_pending_updates: true });
});

// ⑩ admins：add 缺则增（重复 add 不重复插）、remove 删除，各写审计；非法 body → 400
it('admins add/remove：白名单增删生效并写审计；非法 body → 400', async () => {
  await seedBot(4251, 'k-admin-admins', '');
  stubTelegram({ getMe: () => meResult(4251) });

  const add = await adminPost('/admin/admins', {
    token: env.ADMIN_SETUP_SECRET,
    body: { action: 'add', user_ids: [555, 666], display_name: 'Alice' },
  });
  expect(add.status).toBe(200);
  expect(await add.json()).toEqual({ ok: true, action: 'add', added: 2 });

  const duplicate = await adminPost('/admin/admins', {
    token: env.ADMIN_SETUP_SECRET,
    body: { action: 'add', user_ids: [555] },
  });
  expect(await duplicate.json()).toEqual({ ok: true, action: 'add', added: 0 }); // 缺则增，不重复

  const bot = await db.prepare('SELECT id FROM bots WHERE telegram_bot_id = ?').bind(4251).first<BotRow>();
  const afterAdd = await db.prepare('SELECT telegram_user_id, display_name FROM support_admins WHERE bot_id = ? ORDER BY telegram_user_id').bind(bot?.id).all<SupportAdminRow>();
  // display_name 是请求级可选字段，作用于本次 add 的全部 user_ids
  expect(afterAdd.results).toEqual([
    { telegram_user_id: 555, display_name: 'Alice' },
    { telegram_user_id: 666, display_name: 'Alice' },
  ]);

  const remove = await adminPost('/admin/admins', {
    token: env.ADMIN_SETUP_SECRET,
    body: { action: 'remove', user_ids: [555] },
  });
  expect(remove.status).toBe(200);
  expect(await remove.json()).toEqual({ ok: true, action: 'remove', removed: 1 });

  const afterRemove = await db.prepare('SELECT telegram_user_id FROM support_admins WHERE bot_id = ? ORDER BY telegram_user_id').bind(bot?.id).all<SupportAdminRow>();
  expect(afterRemove.results.map((row) => row.telegram_user_id)).toEqual([666]);

  const addAudit = await db.prepare("SELECT detail_json FROM audit_logs WHERE action = 'admin_add' ORDER BY id ASC").all<AuditRow>();
  const removeAudit = await db.prepare("SELECT detail_json FROM audit_logs WHERE action = 'admin_remove'").first<AuditRow>();
  expect(JSON.parse(addAudit.results[0]?.detail_json ?? '{}')).toMatchObject({ user_ids: [555, 666], added: 2 });
  expect(JSON.parse(removeAudit?.detail_json ?? '{}')).toMatchObject({ user_ids: [555], removed: 1 });

  // 非法 body → 400
  const badAction = await adminPost('/admin/admins', { token: env.ADMIN_SETUP_SECRET, body: { action: 'bogus', user_ids: [1] } });
  expect(badAction.status).toBe(400);
  const badIds = await adminPost('/admin/admins', { token: env.ADMIN_SETUP_SECRET, body: { action: 'add', user_ids: 'nope' } });
  expect(badIds.status).toBe(400);
});

// ⑪ /admin/* POST only：GET → 404；/health 仍是唯一 GET
it('GET /admin/* → 404；GET /health 仍 200（唯一 GET，docs/05）', async () => {
  const setup = await SELF.fetch('https://test.example.com/admin/setup');
  expect(setup.status).toBe(404);
  const unknown = await SELF.fetch('https://test.example.com/admin/nope');
  expect(unknown.status).toBe(404);
  const health = await SELF.fetch('https://test.example.com/health');
  expect(health.status).toBe(200);
});
