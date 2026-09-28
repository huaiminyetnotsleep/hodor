import { beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { handleCommand } from '../src/pipeline/commands';
import { handleInbound } from '../src/pipeline/inbound';
import { RISK_SET_NOTICE, WATCH_NOTICE } from '../src/domain/copy';
import type { UpdateContext } from '../src/domain';
import type { TelegramClient, TelegramUpdate } from '../src/telegram';
import type { Bot } from '../src/store';
import { callsOf, makeTelegram, type MethodStub } from './telegram-stub';

// design.md 测试设计（S7）：①/risk 全链路（flag=1 → ⚠️ → 置位提示一次 → 删消息 → audit）
// ②已 blocked 用户 /risk（🔇 保持、提示照发、blocked 不变）③/unrisk（👤、无解除提示、audit）
// ④白名单外零副作用 ⑤正交锁定（/ban → 🔇 → /unban → ⚠️ 恢复，watchlisted 全程未被清除）
// ⑥WATCH_NOTICE 首次入站发送+时间戳写入 ⑦24h 内（1h 前）不重发 ⑧超 24h（25h 前）再发+刷新
// ⑨/risk 命令不进 copyMessage。
// 真 D1（cloudflare-pool + 本文件隔离存储）+ 桩 telegram client（makeTelegram 共用）；
// last_watch_notice_at 边界用真实时钟减偏移的种子行控制（design.md：不注入假时钟）。

const db = env.DB;
const BOT_ID = 1;
const SUPPORT_CHAT_ID = -100666002;
const ADMIN_ID = 8811;
const OUTSIDER_ID = 8812;

const BOT: Bot = {
  id: BOT_ID,
  telegram_bot_id: 4402,
  webhook_key: 'k-admin-risk-test-bot',
  encrypted_bot_token: null,
  webhook_secret_hash: 'sha256hex',
  support_chat_id: SUPPORT_CHAT_ID,
  status: 'active',
  config_version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

// ── telegram 桩（docs/10：fetch 层打桩；未编排 method 抛错 = 「不得发生」断言）──────────

/** 命令链路正常桩：editForumTopic / deleteMessage / sendMessage / reopenForumTopic 全部成功 */
const commandOkStubs = (): Record<string, MethodStub> => ({
  editForumTopic: () => true,
  deleteMessage: () => true,
  reopenForumTopic: () => true,
  sendMessage: () => ({ message_id: 7777 }),
});

/** 入站链路正常桩：命令桩 + copyMessage（高危用户照常中继，docs/04） */
const inboundOkStubs = (): Record<string, MethodStub> => ({
  ...commandOkStubs(),
  copyMessage: () => ({ message_id: 8888 }),
});

// ── Update 构造（docs/03 判空原则：只给链路消费的字段）────────────────────────────────

function commandUpdate(updateId: number, messageId: number, senderId: number, text: string, threadId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: senderId, is_bot: false, first_name: 'Admin' },
      chat: { id: SUPPORT_CHAT_ID, type: 'supergroup' },
      date: 1760000000,
      message_thread_id: threadId,
      text,
    },
  };
}

function privateTextUpdate(updateId: number, userId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'Nick' },
      chat: { id: userId, type: 'private' },
      date: 1760000000,
      text,
    },
  };
}

function ctxFor(update: TelegramUpdate, telegram: TelegramClient): UpdateContext {
  return { env: { ...env }, db, telegram, bot: BOT, update };
}

// ── DB 视图与种子 ────────────────────────────────────────────────────────────

interface CustomerView {
  id: number;
  blocked: number;
  watchlisted: number;
  last_watch_notice_at: string | null;
}

async function customerRow(botId: number, telegramUserId: number): Promise<CustomerView | null> {
  return db
    .prepare('SELECT id, blocked, watchlisted, last_watch_notice_at FROM customers WHERE bot_id = ? AND telegram_user_id = ?')
    .bind(botId, telegramUserId)
    .first<CustomerView>();
}

interface ConversationView {
  status: string;
  canonical_title: string | null;
}

async function conversationRow(conversationId: number): Promise<ConversationView | null> {
  return db
    .prepare('SELECT status, canonical_title FROM conversations WHERE id = ?')
    .bind(conversationId)
    .first<ConversationView>();
}

interface AuditView {
  id: number;
  actor_type: string;
  actor_id: number | null;
  action: string;
  detail_json: string | null;
}

async function auditRows(action: string): Promise<AuditView[]> {
  const res = await db
    .prepare('SELECT id, actor_type, actor_id, action, detail_json FROM audit_logs WHERE bot_id = ? AND action = ? ORDER BY id')
    .bind(BOT_ID, action)
    .all<AuditView>();
  return res.results;
}

/** 按 detail.customer_id 过滤（同 action 在同文件各用例间累积，按目标隔离断言） */
function auditsForCustomer(rows: AuditView[], customerId: number): AuditView[] {
  return rows.filter((row) => {
    try {
      return (JSON.parse(row.detail_json ?? '{}') as { customer_id?: number }).customer_id === customerId;
    } catch {
      return false;
    }
  });
}

async function messagesCount(conversationId: number): Promise<number> {
  const res = await db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
    .bind(conversationId)
    .first<{ n: number }>();
  return res?.n ?? 0;
}

const SEED_TS = '2026-01-02T00:00:00Z';

async function seedCustomer(
  botId: number,
  telegramUserId: number,
  options: { watchlisted?: number; blocked?: number; lastWatchNoticeAt?: string } = {},
): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO customers (bot_id, telegram_user_id, display_name, blocked, watchlisted, last_watch_notice_at, created_at, updated_at) VALUES (?, ?, 'Nick', ?, ?, ?, ?, ?)",
    )
    .bind(
      botId,
      telegramUserId,
      options.blocked ?? 0,
      options.watchlisted ?? 0,
      options.lastWatchNoticeAt ?? null,
      SEED_TS,
      SEED_TS,
    )
    .run();
  return res.meta.last_row_id;
}

async function seedConversation(
  botId: number,
  customerId: number,
  supportChatId: number,
  threadId: number,
  status = 'open',
): Promise<number> {
  const res = await db
    .prepare(
      'INSERT INTO conversations (bot_id, customer_id, support_chat_id, message_thread_id, status, canonical_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(botId, customerId, supportChatId, threadId, status, `👤 Nick ${customerId}`, SEED_TS, SEED_TS)
    .run();
  return res.meta.last_row_id;
}

async function seedAdmin(botId: number, telegramUserId: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO support_admins (bot_id, telegram_user_id, display_name, created_at) VALUES (?, ?, ?, ?)')
    .bind(botId, telegramUserId, 'Admin', SEED_TS)
    .run();
}

/** 真实时钟回退（design.md：种子行控制 last_watch_notice_at 边界，不注入假时钟） */
function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await db
    .prepare(
      "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (4402, 'k-admin-risk-test-bot', 'sha256hex', -100666002, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .run();
  // 全套件共用白名单管理员（docs/04 步骤 1 前置）；用例 ④ 用 OUTSIDER_ID 单独测白名单外分支
  await seedAdmin(BOT_ID, ADMIN_ID);
});

// ── design.md 测试设计 ①–⑨ ──────────────────────────────────────────────────

describe('/risk /unrisk 命令（design.md 测试设计 ①–⑤、⑨）', () => {
  it('① /risk 全链路：flag=1 → ⚠️ 标题重渲染 → 置位提示一次 → 删消息 → audit risk（docs/04）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9901);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 1001);
    const { telegram, calls } = makeTelegram(commandOkStubs());

    await expect(handleCommand(ctxFor(commandUpdate(5001, 5001, ADMIN_ID, '/risk', 1001), telegram))).resolves
      .toBeUndefined();

    // 步骤 1：watchlisted 唯一事实源写入；正交性：/risk 不改 blocked
    const row = await customerRow(BOT_ID, 9901);
    expect(row?.watchlisted).toBe(1);
    expect(row?.blocked).toBe(0);

    // 步骤 2：标题全量重渲染 ⚠️（docs/02：绝不在旧标题上追加）+ canonical_title 同步
    const edits = callsOf(calls, 'editForumTopic');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 1001,
      name: `⚠️ Nick 9901 · #${customerId}`,
    });
    expect((await conversationRow(conversationId))?.canonical_title).toBe(`⚠️ Nick 9901 · #${customerId}`);

    // 步骤 3：置位提示一次（发进本 Topic）
    const notices = callsOf(calls, 'sendMessage');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 1001,
      text: RISK_SET_NOTICE,
    });

    // 步骤 4：命令消息删除
    const deletes = callsOf(calls, 'deleteMessage');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.payload).toEqual({ chat_id: SUPPORT_CHAT_ID, message_id: 5001 });

    // 审计：actor、target；detail 不含消息内容
    const riskAudits = auditsForCustomer(await auditRows('risk'), customerId);
    expect(riskAudits).toHaveLength(1);
    expect(riskAudits[0]).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, action: 'risk' });
    expect(JSON.parse(riskAudits[0]?.detail_json ?? '{}')).toEqual({
      customer_id: customerId,
      telegram_user_id: 9901,
    });
  });

  it('② 已 blocked 用户 /risk：🔇 保持、置位提示照发、blocked 不变（docs/02 封禁优先）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9902, { blocked: 1 });
    await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 1002);
    const { telegram, calls } = makeTelegram(commandOkStubs());

    await handleCommand(ctxFor(commandUpdate(5002, 5002, ADMIN_ID, '/risk', 1002), telegram));

    const row = await customerRow(BOT_ID, 9902);
    expect(row?.blocked).toBe(1); // 封禁独立不受影响
    expect(row?.watchlisted).toBe(1);
    expect(callsOf(calls, 'editForumTopic')[0]?.payload).toMatchObject({
      name: `🔇 Nick 9902 · #${customerId}`, // 🔇 > ⚠️（docs/02 优先级）
    });
    expect(callsOf(calls, 'sendMessage')).toHaveLength(1); // 置位提示照发
    expect(callsOf(calls, 'deleteMessage')).toHaveLength(1);
    expect(auditsForCustomer(await auditRows('risk'), customerId)).toHaveLength(1);
  });

  it('③ /unrisk：flag=0 → 👤 标题、无解除提示、删消息、audit unrisk（docs/04 对称）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9903, { watchlisted: 1 });
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 1003);
    const { telegram, calls } = makeTelegram(commandOkStubs());

    await expect(handleCommand(ctxFor(commandUpdate(5003, 5003, ADMIN_ID, '/unrisk', 1003), telegram))).resolves
      .toBeUndefined();

    expect((await customerRow(BOT_ID, 9903))?.watchlisted).toBe(0);
    expect(callsOf(calls, 'editForumTopic')[0]?.payload).toMatchObject({
      name: `👤 Nick 9903 · #${customerId}`,
    });
    expect((await conversationRow(conversationId))?.canonical_title).toBe(`👤 Nick 9903 · #${customerId}`);
    expect(callsOf(calls, 'sendMessage')).toHaveLength(0); // 无解除提示（docs/04 未要求）
    expect(callsOf(calls, 'deleteMessage')).toHaveLength(1);
    const unriskAudits = auditsForCustomer(await auditRows('unrisk'), customerId);
    expect(unriskAudits).toHaveLength(1);
    expect(unriskAudits[0]).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, action: 'unrisk' });
  });

  it('④ 白名单外 /risk 零副作用（不删消息、零外呼、不写库、不审计，docs/04 步骤 1）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9904);
    await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 1004);
    const auditBefore = (await auditRows('risk')).length;
    const { telegram, calls } = makeTelegram(commandOkStubs());

    await expect(handleCommand(ctxFor(commandUpdate(5004, 5004, OUTSIDER_ID, '/risk', 1004), telegram))).resolves
      .toBeUndefined();

    expect(calls).toHaveLength(0);
    expect((await customerRow(BOT_ID, 9904))?.watchlisted).toBe(0);
    expect((await auditRows('risk')).length).toBe(auditBefore);
  });

  it('⑤ 正交锁定：watchlisted=1 → /ban 🔇 → /unban ⚠️ 恢复（watchlisted 全程未被清除，docs/04）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9905, { watchlisted: 1 });
    await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 1005);

    const ban = makeTelegram(commandOkStubs());
    await handleCommand(ctxFor(commandUpdate(5005, 5005, ADMIN_ID, '/ban', 1005), ban.telegram));

    // /ban 只写 blocked，不清 watchlisted；两标志并存时 🔇 封禁优先（docs/02）
    expect(await customerRow(BOT_ID, 9905)).toMatchObject({ blocked: 1, watchlisted: 1 });
    expect(callsOf(ban.calls, 'editForumTopic')[0]?.payload).toMatchObject({
      name: `🔇 Nick 9905 · #${customerId}`,
    });

    const unban = makeTelegram(commandOkStubs());
    await handleCommand(ctxFor(commandUpdate(5015, 5015, ADMIN_ID, '/unban', 1005), unban.telegram));

    // 解封 ≠ 移出名单：⚠️ 恢复（watchlisted 仍 1）
    expect(await customerRow(BOT_ID, 9905)).toMatchObject({ blocked: 0, watchlisted: 1 });
    expect(callsOf(unban.calls, 'editForumTopic')[0]?.payload).toMatchObject({
      name: `⚠️ Nick 9905 · #${customerId}`,
    });
  });

  it('⑨ /risk 命令不进 copyMessage、不落 messages（docs/03/04：命令绝不中继）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9909);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 1009);
    const { telegram, calls } = makeTelegram(commandOkStubs());

    await handleCommand(ctxFor(commandUpdate(5009, 5009, ADMIN_ID, '/risk', 1009), telegram));

    expect(callsOf(calls, 'copyMessage')).toHaveLength(0);
    expect(await messagesCount(conversationId)).toBe(0);
    expect((await customerRow(BOT_ID, 9909))?.watchlisted).toBe(1); // 命令本身照常执行
  });
});

describe('入站 WATCH_NOTICE 24h 限频（design.md 测试设计 ⑥–⑧，docs/03 步骤 11）', () => {
  it('⑥ last_watch_notice_at=NULL 首次入站 → 发提示 + 写时间戳（消息照常中继）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9906, { watchlisted: 1 });
    await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 1006);
    const { telegram, calls } = makeTelegram(inboundOkStubs());
    const t0 = Date.now();

    await expect(handleInbound(ctxFor(privateTextUpdate(5106, 9906, 'hello'), telegram))).resolves.toBeUndefined();

    // 高危不影响中继（docs/04：入站照常中继）
    expect(callsOf(calls, 'copyMessage')).toHaveLength(1);

    const notices = callsOf(calls, 'sendMessage');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 1006,
      text: WATCH_NOTICE,
    });

    const ts = (await customerRow(BOT_ID, 9906))?.last_watch_notice_at;
    expect(ts).not.toBeNull();
    expect(Date.parse(ts!)).toBeGreaterThanOrEqual(t0 - 1000); // 刷新为本次入站时刻
    expect(Date.parse(ts!)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('⑦ 24h 内（1h 前已提示）→ 不重发、时间戳不变（docs/04 限频不刷屏）', async () => {
    const stamped = hoursAgoIso(1);
    const customerId = await seedCustomer(BOT_ID, 9907, { watchlisted: 1, lastWatchNoticeAt: stamped });
    await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 1007);
    const { telegram, calls } = makeTelegram(inboundOkStubs());

    await handleInbound(ctxFor(privateTextUpdate(5107, 9907, 'again'), telegram));

    expect(callsOf(calls, 'sendMessage')).toHaveLength(0); // 静默：24h 内不重复提示
    expect(callsOf(calls, 'copyMessage')).toHaveLength(1); // 中继照常
    expect((await customerRow(BOT_ID, 9907))?.last_watch_notice_at).toBe(stamped); // 时间戳不刷新
  });

  it('⑧ 超 24h（25h 前已提示）→ 再发提示 + 刷新时间戳', async () => {
    const stamped = hoursAgoIso(25);
    const customerId = await seedCustomer(BOT_ID, 9908, { watchlisted: 1, lastWatchNoticeAt: stamped });
    await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 1008);
    const { telegram, calls } = makeTelegram(inboundOkStubs());
    const t0 = Date.now();

    await handleInbound(ctxFor(privateTextUpdate(5108, 9908, 'back again'), telegram));

    const notices = callsOf(calls, 'sendMessage');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 1008,
      text: WATCH_NOTICE,
    });
    const ts = (await customerRow(BOT_ID, 9908))?.last_watch_notice_at;
    expect(ts).not.toBeNull();
    expect(ts).not.toBe(stamped);
    expect(Date.parse(ts!)).toBeGreaterThanOrEqual(t0 - 1000); // 已刷新
  });
});
