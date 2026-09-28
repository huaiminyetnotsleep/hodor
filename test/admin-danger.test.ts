import { beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { handleCommand } from '../src/pipeline/commands';
import { handleInbound } from '../src/pipeline/inbound';
import {
  CONFIRM_EXPIRED_NOTICE,
  CONFIRM_MISMATCH_NOTICE,
  renderDeluserConfirmPrompt,
  renderPurgeConfirmPrompt,
} from '../src/domain/copy';
import type { UpdateContext } from '../src/domain';
import type { TelegramClient, TelegramUpdate } from '../src/telegram';
import type { Bot } from '../src/store';
import { callsOf, makeTelegram, type MethodStub } from './telegram-stub';

// design.md 测试设计（S8）：①/purge 发起（只 audit+提示，零删除零 deleteForumTopic）
// ②confirm 序号不匹配拒绝 ③confirm 超时拒绝（种子 audit created_at 11min 前）
// ④confirm 成功全链路（messages/conversations 删、customer 保留、Topic 删、General 公告、两条 audit）
// ⑤重复 confirm 幂等（反查失败 → 静默）⑥/deluser 墓碑先于 customer 删除 ⑦deluser 后非 /start 静默
// ⑧/start 复活（新 #序号 + was_watchlisted 继承）⑨白名单外零副作用 ⑩deleteForumTopic permanent
// 视为已删继续。
// S10 补齐（docs/10 管理命令清单「/deluser:confirm 序号不匹配 / 超时拒绝…重复 confirm 幂等」）：
// ⑥b /deluser confirm 序号不匹配 ⑥c /deluser confirm 超时（种子 audit 11min 前）⑥d /deluser 重复 confirm 幂等。
// 真 D1（cloudflare-pool + 本文件隔离存储）+ 桩 telegram client（makeTelegram 共用；
// 未编排 method 抛错 = 「不得发生」断言）；超时窗口用真实时钟减偏移的种子审计行控制（design.md：不注入假时钟）。

const db = env.DB;
const BOT_ID = 1;
const SUPPORT_CHAT_ID = -100666003;
const ADMIN_ID = 8821;
const OUTSIDER_ID = 8822;

const BOT: Bot = {
  id: BOT_ID,
  telegram_bot_id: 4403,
  webhook_key: 'k-admin-danger-test-bot',
  encrypted_bot_token: null,
  webhook_secret_hash: 'sha256hex',
  support_chat_id: SUPPORT_CHAT_ID,
  status: 'active',
  config_version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

// ── telegram 桩（docs/10：fetch 层打桩）──────────────────────────────────────

/** 危险命令正常桩：deleteMessage / deleteForumTopic / sendMessage 全部成功（deleteForumTopic 有意编排 = 允许发生） */
const dangerOkStubs = (): Record<string, MethodStub> => ({
  deleteMessage: () => true,
  deleteForumTopic: () => true,
  sendMessage: () => ({ message_id: 7777 }),
});

/** 仅提示桩：只有 sendMessage 可用——拒绝路径不得删消息、不得删 Topic（调用即抛错） */
const noticeOnlyStubs = (): Record<string, MethodStub> => ({
  sendMessage: () => ({ message_id: 7777 }),
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
  telegram_user_id: number;
  blocked: number;
  watchlisted: number;
}

async function customerRow(botId: number, telegramUserId: number): Promise<CustomerView | null> {
  return db
    .prepare('SELECT id, telegram_user_id, blocked, watchlisted FROM customers WHERE bot_id = ? AND telegram_user_id = ?')
    .bind(botId, telegramUserId)
    .first<CustomerView>();
}

async function conversationsCount(customerId: number): Promise<number> {
  const res = await db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE customer_id = ?').bind(customerId).first<{ n: number }>();
  return res?.n ?? 0;
}

async function messagesCount(conversationId: number): Promise<number> {
  const res = await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').bind(conversationId).first<{ n: number }>();
  return res?.n ?? 0;
}

interface TombstoneView {
  bot_id: number;
  telegram_user_id: number;
  was_watchlisted: number;
  deleted_by: number | null;
}

async function tombstoneRow(botId: number, telegramUserId: number): Promise<TombstoneView | null> {
  return db
    .prepare('SELECT bot_id, telegram_user_id, was_watchlisted, deleted_by FROM deleted_users WHERE bot_id = ? AND telegram_user_id = ?')
    .bind(botId, telegramUserId)
    .first<TombstoneView>();
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

const SEED_TS = '2026-01-02T00:00:00Z';

async function seedCustomer(
  botId: number,
  telegramUserId: number,
  options: { watchlisted?: number; blocked?: number } = {},
): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO customers (bot_id, telegram_user_id, display_name, blocked, watchlisted, created_at, updated_at) VALUES (?, ?, 'Nick', ?, ?, ?, ?)",
    )
    .bind(botId, telegramUserId, options.blocked ?? 0, options.watchlisted ?? 0, SEED_TS, SEED_TS)
    .run();
  return res.meta.last_row_id;
}

async function seedConversation(
  botId: number,
  customerId: number,
  supportChatId: number,
  threadId: number,
): Promise<number> {
  const res = await db
    .prepare(
      'INSERT INTO conversations (bot_id, customer_id, support_chat_id, message_thread_id, status, canonical_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(botId, customerId, supportChatId, threadId, 'open', `👤 Nick ${customerId}`, SEED_TS, SEED_TS)
    .run();
  return res.meta.last_row_id;
}

async function seedMessage(conversationId: number, threadId: number, sourceMessageId: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO messages (conversation_id, direction, source_chat_id, source_message_id, target_chat_id, target_message_id, message_thread_id, content_type, text_content, created_at) VALUES (?, 'inbound', ?, ?, ?, ?, ?, 'text', 'seed', ?)",
    )
    .bind(conversationId, 555001, sourceMessageId, SUPPORT_CHAT_ID, 880001 + sourceMessageId, threadId, SEED_TS)
    .run();
}

/** 直接种发起审计行（created_at 可控——超时窗口边界用真实时钟减偏移，design.md：不注入假时钟） */
async function seedIntentAudit(
  action: string,
  customerId: number,
  telegramUserId: number,
  createdAtIso: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO audit_logs (bot_id, actor_type, actor_id, action, detail_json, created_at) VALUES (?, 'admin', ?, ?, ?, ?)",
    )
    .bind(BOT_ID, ADMIN_ID, action, JSON.stringify({ customer_id: customerId, telegram_user_id: telegramUserId }), createdAtIso)
    .run();
}

async function seedAdmin(botId: number, telegramUserId: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO support_admins (bot_id, telegram_user_id, display_name, created_at) VALUES (?, ?, ?, ?)')
    .bind(botId, telegramUserId, 'Admin', SEED_TS)
    .run();
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

type TelegramCallList = ReturnType<typeof makeTelegram>['calls'];

/** 两步走完一次 /deluser（发起 + confirm），返回 confirm 阶段的调用记录（供顺序断言） */
async function executeDeluser(customerId: number, threadId: number, updateId: number): Promise<TelegramCallList> {
  const initiate = makeTelegram(dangerOkStubs());
  await handleCommand(ctxFor(commandUpdate(updateId, updateId, ADMIN_ID, '/deluser', threadId), initiate.telegram));
  const confirm = makeTelegram(dangerOkStubs());
  await handleCommand(
    ctxFor(commandUpdate(updateId + 1, updateId + 1, ADMIN_ID, `/deluser confirm ${customerId}`, threadId), confirm.telegram),
  );
  return confirm.calls;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await db
    .prepare(
      "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (4403, 'k-admin-danger-test-bot', 'sha256hex', -100666003, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .run();
  // 全套件共用白名单管理员（docs/04 步骤 1 前置）；用例 ⑨ 用 OUTSIDER_ID 单独测白名单外分支
  await seedAdmin(BOT_ID, ADMIN_ID);
});

// ── design.md 测试设计 ①–⑩ ──────────────────────────────────────────────────

describe('/purge 两步确认（design.md 测试设计 ①–⑤、⑩）', () => {
  it('① /purge 发起：只写发起 audit + 确认提示 + 删命令消息，零删除零 deleteForumTopic（docs/04 步骤 2）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9931);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2001);
    await seedMessage(conversationId, 2001, 7001);
    const { telegram, calls } = makeTelegram(dangerOkStubs());

    await expect(handleCommand(ctxFor(commandUpdate(7011, 7011, ADMIN_ID, '/purge', 2001), telegram))).resolves
      .toBeUndefined();

    // 零删除：messages / conversations / customers 全部原样
    expect(await messagesCount(conversationId)).toBe(1);
    expect(await conversationsCount(customerId)).toBe(1);
    expect(await customerRow(BOT_ID, 9931)).not.toBeNull();
    expect(callsOf(calls, 'deleteForumTopic')).toHaveLength(0); // 桩未编排也未被调用

    // 确认提示：发进本 Topic，含 #序号 与 confirm 用法（docs/04 步骤 2 文案要素）
    const prompts = callsOf(calls, 'sendMessage');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 2001,
      text: renderPurgeConfirmPrompt(customerId),
    });

    // 命令消息删除 + 发起审计一条（无 confirmed 标记）
    expect(callsOf(calls, 'deleteMessage')).toHaveLength(1);
    const initiations = auditsForCustomer(await auditRows('purge'), customerId);
    expect(initiations).toHaveLength(1);
    expect(initiations[0]).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, action: 'purge' });
    expect(JSON.parse(initiations[0]?.detail_json ?? '{}')).toEqual({
      customer_id: customerId,
      telegram_user_id: 9931,
    });
  });

  it('② confirm 序号不匹配拒绝：零删除、无执行 audit、提示作废（docs/04 步骤 3）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9932);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2002);
    await seedMessage(conversationId, 2002, 7002);
    await handleCommand(ctxFor(commandUpdate(7012, 7012, ADMIN_ID, '/purge', 2002), makeTelegram(dangerOkStubs()).telegram));

    const { telegram, calls } = makeTelegram(noticeOnlyStubs()); // 删消息/删 Topic 未编排 = 不得发生
    await handleCommand(
      ctxFor(commandUpdate(7013, 7013, ADMIN_ID, `/purge confirm ${customerId + 100}`, 2002), telegram),
    );

    // 零删除 + 无执行审计（仅发起一条，无 confirmed）
    expect(await messagesCount(conversationId)).toBe(1);
    expect(await conversationsCount(customerId)).toBe(1);
    expect(await customerRow(BOT_ID, 9932)).not.toBeNull();
    const audits = auditsForCustomer(await auditRows('purge'), customerId);
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]?.detail_json ?? '{}')).toEqual({
      customer_id: customerId,
      telegram_user_id: 9932,
    });

    // 拒绝提示（不发删除类外呼）
    const notices = callsOf(calls, 'sendMessage');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 2002,
      text: CONFIRM_MISMATCH_NOTICE,
    });
  });

  it('③ confirm 超时拒绝：种子发起 audit 为 11 分钟前 → 提示作废、零删除、无执行 audit（docs/04 步骤 3）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9933);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2003);
    await seedMessage(conversationId, 2003, 7003);
    await seedIntentAudit('purge', customerId, 9933, minutesAgoIso(11)); // 超出 10 分钟窗口

    const { telegram, calls } = makeTelegram(noticeOnlyStubs());
    await handleCommand(
      ctxFor(commandUpdate(7014, 7014, ADMIN_ID, `/purge confirm ${customerId}`, 2003), telegram),
    );

    expect(await messagesCount(conversationId)).toBe(1);
    expect(await conversationsCount(customerId)).toBe(1);
    const audits = auditsForCustomer(await auditRows('purge'), customerId);
    expect(audits).toHaveLength(1); // 只有种子发起行，无执行审计
    expect(JSON.parse(audits[0]?.detail_json ?? '{}').confirmed).toBeUndefined();
    const notices = callsOf(calls, 'sendMessage');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 2003,
      text: CONFIRM_EXPIRED_NOTICE,
    });
  });

  it('④ confirm 成功全链路：messages/conversations 删、customer 保留、Topic 删、General 公告、两条 audit（docs/04 步骤 4）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9934);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2004);
    await seedMessage(conversationId, 2004, 7004);
    await seedMessage(conversationId, 2004, 7005);
    await handleCommand(ctxFor(commandUpdate(7015, 7015, ADMIN_ID, '/purge', 2004), makeTelegram(dangerOkStubs()).telegram));

    // confirm 序号用 "#<序号>" 形式（docs/04：两种写法等价）
    const { telegram, calls } = makeTelegram(dangerOkStubs());
    await handleCommand(
      ctxFor(commandUpdate(7016, 7016, ADMIN_ID, `/purge confirm #${customerId}`, 2004), telegram),
    );

    // D1：该客户 messages / conversations 清空，customer 行保留（同 #序号新会话，docs/10 场景 19）
    expect(await messagesCount(conversationId)).toBe(0);
    expect(await conversationsCount(customerId)).toBe(0);
    expect(await customerRow(BOT_ID, 9934)).toMatchObject({ id: customerId, blocked: 0, watchlisted: 0 });

    // Telegram：整题删除一次 + General Topic（thread=1）公告，文案含 #序号
    expect(callsOf(calls, 'deleteForumTopic')).toHaveLength(1);
    expect(callsOf(calls, 'deleteForumTopic')[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 2004,
    });
    const announcements = callsOf(calls, 'sendMessage');
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 1, // General Topic
      text: expect.stringContaining(`#${customerId}`),
    });

    // 打桩调用顺序：命令消息删除 → deleteForumTopic（最后的删除步骤）→ General 公告
    const methods = calls.map((c) => c.method);
    expect(methods.indexOf('deleteForumTopic')).toBeGreaterThan(methods.indexOf('deleteMessage'));
    expect(methods.indexOf('sendMessage')).toBeGreaterThan(methods.indexOf('deleteForumTopic'));

    // 审计两条：发起 + 执行（confirmed=true，审计先行——先于一切删除落库）
    const audits = auditsForCustomer(await auditRows('purge'), customerId);
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1]?.detail_json ?? '{}')).toMatchObject({
      customer_id: customerId,
      telegram_user_id: 9934,
      confirmed: true,
    });
    expect(audits[1]).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, action: 'purge' });
  });

  it('⑤ 重复 confirm 幂等：Topic 已删、会话已清 → 反查失败静默（零外呼、无新 audit）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9935);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2005);
    await handleCommand(ctxFor(commandUpdate(7017, 7017, ADMIN_ID, '/purge', 2005), makeTelegram(dangerOkStubs()).telegram));
    await handleCommand(
      ctxFor(commandUpdate(7018, 7018, ADMIN_ID, `/purge confirm ${customerId}`, 2005), makeTelegram(dangerOkStubs()).telegram),
    );
    expect(await conversationsCount(customerId)).toBe(0); // 前置：已成功清除

    // 幂等桩：空编排——任何外呼都会抛错；反查失败必须整体静默
    const { telegram, calls } = makeTelegram({});
    await expect(
      handleCommand(ctxFor(commandUpdate(7019, 7019, ADMIN_ID, `/purge confirm ${customerId}`, 2005), telegram)),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    expect(await conversationsCount(customerId)).toBe(0);
    expect(await messagesCount(conversationId)).toBe(0);
    expect(auditsForCustomer(await auditRows('purge'), customerId)).toHaveLength(2); // 不再追加执行审计
  });

  it('⑩ deleteForumTopic permanent（400 Topic 已删）→ 视为已删继续，执行到 General 公告（docs/04 崩溃窗口预案）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9940);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2010);
    await seedMessage(conversationId, 2010, 7010);
    await handleCommand(ctxFor(commandUpdate(7025, 7025, ADMIN_ID, '/purge', 2010), makeTelegram(dangerOkStubs()).telegram));

    // deleteForumTopic 返回 400（Topic 已删类永久错误）→ permanent → 不抛出、继续公告
    const { telegram, calls } = makeTelegram({
      deleteMessage: () => true,
      deleteForumTopic: () => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: topic not found' } }),
      sendMessage: () => ({ message_id: 7777 }),
    });
    await expect(
      handleCommand(ctxFor(commandUpdate(7026, 7026, ADMIN_ID, `/purge confirm ${customerId}`, 2010), telegram)),
    ).resolves.toBeUndefined();

    expect(await messagesCount(conversationId)).toBe(0); // 数据删除不受影响
    expect(await conversationsCount(customerId)).toBe(0);
    expect(callsOf(calls, 'deleteForumTopic')).toHaveLength(1);
    expect(callsOf(calls, 'sendMessage')).toHaveLength(1); // General 公告照发
    expect(callsOf(calls, 'sendMessage')[0]?.payload).toMatchObject({ message_thread_id: 1 });
    const audits = auditsForCustomer(await auditRows('purge'), customerId);
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1]?.detail_json ?? '{}').confirmed).toBe(true);
  });
});

describe('/deluser 两步确认与墓碑语义（design.md 测试设计 ⑥–⑧）', () => {
  it('⑥ /deluser confirm：墓碑先于 customer 删除（墓碑行在、customers 行无、继承字段对）、全链路 audit', async () => {
    const customerId = await seedCustomer(BOT_ID, 9936, { watchlisted: 1 });
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2006);
    await seedMessage(conversationId, 2006, 7006);

    const initiate = makeTelegram(dangerOkStubs());
    await handleCommand(ctxFor(commandUpdate(7021, 7021, ADMIN_ID, '/deluser', 2006), initiate.telegram));
    // 发起段：确认提示（含 /deluser confirm 用法），零删除
    expect(callsOf(initiate.calls, 'sendMessage')[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 2006,
      text: renderDeluserConfirmPrompt(customerId),
    });
    expect(await customerRow(BOT_ID, 9936)).not.toBeNull();
    expect(await tombstoneRow(BOT_ID, 9936)).toBeNull(); // 发起段不写墓碑

    const confirm = makeTelegram(dangerOkStubs());
    await handleCommand(
      ctxFor(commandUpdate(7022, 7022, ADMIN_ID, `/deluser confirm ${customerId}`, 2006), confirm.telegram),
    );
    const confirmCalls = confirm.calls;

    // 墓碑先于删除的终态断言（design.md ⑥）：墓碑行存在且 customers 行不存在
    expect(await tombstoneRow(BOT_ID, 9936)).toEqual({
      bot_id: BOT_ID,
      telegram_user_id: 9936,
      was_watchlisted: 1, // 继承自被删客户的高危标志（docs/04）
      deleted_by: ADMIN_ID, // deleted_by = actor
    });
    expect(await customerRow(BOT_ID, 9936)).toBeNull();
    expect(await messagesCount(conversationId)).toBe(0);
    expect(await conversationsCount(customerId)).toBe(0);

    // Topic 删除 + General 公告（thread=1、含 #序号）
    expect(callsOf(confirmCalls, 'deleteForumTopic')).toHaveLength(1);
    const announcements = callsOf(confirmCalls, 'sendMessage');
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 1,
      text: expect.stringContaining(`#${customerId}`),
    });
    // 打桩调用顺序：deleteForumTopic 在公告之前（最后的删除步骤）
    const methods = confirmCalls.map((c) => c.method);
    expect(methods.indexOf('sendMessage')).toBeGreaterThan(methods.indexOf('deleteForumTopic'));

    // 审计两条，第二条 confirmed=true
    const audits = auditsForCustomer(await auditRows('deluser'), customerId);
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1]?.detail_json ?? '{}')).toMatchObject({
      customer_id: customerId,
      telegram_user_id: 9936,
      confirmed: true,
    });
    expect(audits[1]).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, action: 'deluser' });
  });

  it('⑦ deluser 后非 /start 静默：入站零外呼、不建客户（docs/03/04 墓碑忽略策略）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9937, { watchlisted: 1 });
    await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2007);
    await executeDeluser(customerId, 2007, 7023);

    // 空桩：任何外呼都会抛错
    const { telegram, calls } = makeTelegram({});
    await expect(handleInbound(ctxFor(privateTextUpdate(7035, 9937, '还在吗？'), telegram))).resolves.toBeUndefined();

    expect(calls).toHaveLength(0); // 全静默
    expect(await customerRow(BOT_ID, 9937)).toBeNull(); // 未自动重建（关门生效）
    expect(await tombstoneRow(BOT_ID, 9937)).not.toBeNull(); // 墓碑仍在
    expect(await conversationsCount(customerId)).toBe(0);
  });

  it('⑧ deluser 后 /start 复活：全新 #序号 + was_watchlisted 继承 + 墓碑清除（docs/03 步骤 4，S4 联调）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9938, { watchlisted: 1 });
    await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2008);
    await executeDeluser(customerId, 2008, 7027);

    const { telegram, calls } = makeTelegram({
      createForumTopic: () => ({ message_thread_id: 2099 }),
      sendMessage: () => ({ message_id: 7800 }),
      copyMessage: () => ({ message_id: 7900 }),
    });
    await expect(handleInbound(ctxFor(privateTextUpdate(7028, 9938, '/start'), telegram))).resolves.toBeUndefined();

    // 全新 #序号（AUTOINCREMENT 不复用）+ 高危标志按墓碑继承（防「删除再回来」绕过，docs/04）
    const revived = await customerRow(BOT_ID, 9938);
    expect(revived).not.toBeNull();
    expect(revived?.id).toBeGreaterThan(customerId);
    expect(revived?.watchlisted).toBe(1);
    expect(await tombstoneRow(BOT_ID, 9938)).toBeNull(); // 墓碑已删除

    // 新会话照常建立、首条消息照常中继（复活 = 全新用户路径），WELCOME 发到私聊
    expect(callsOf(calls, 'createForumTopic')).toHaveLength(1);
    expect(callsOf(calls, 'copyMessage')).toHaveLength(1);
    const welcomes = callsOf(calls, 'sendMessage').filter((c) => c.payload.chat_id === 9938);
    expect(welcomes).toHaveLength(1);
  });
});

describe('白名单前置（design.md 测试设计 ⑨，docs/04 步骤 1）', () => {
  it('⑨ 白名单外 /purge /deluser 零副作用：零外呼、不写库、不审计、不删消息', async () => {
    const customerId = await seedCustomer(BOT_ID, 9939);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2009);
    await seedMessage(conversationId, 2009, 7009);
    const purgeBefore = (await auditRows('purge')).length;
    const deluserBefore = (await auditRows('deluser')).length;

    // 空桩：任何外呼都会抛错
    const { telegram, calls } = makeTelegram({});
    await handleCommand(ctxFor(commandUpdate(7029, 7029, OUTSIDER_ID, '/purge', 2009), telegram));
    await handleCommand(
      ctxFor(commandUpdate(7030, 7030, OUTSIDER_ID, `/purge confirm ${customerId}`, 2009), telegram),
    );
    await handleCommand(ctxFor(commandUpdate(7031, 7031, OUTSIDER_ID, '/deluser', 2009), telegram));

    expect(calls).toHaveLength(0);
    expect(await messagesCount(conversationId)).toBe(1);
    expect(await conversationsCount(customerId)).toBe(1);
    expect(await customerRow(BOT_ID, 9939)).not.toBeNull();
    expect((await auditRows('purge')).length).toBe(purgeBefore);
    expect((await auditRows('deluser')).length).toBe(deluserBefore);
  });
});

// ── /deluser 专属 confirm 边界（S10 补齐，docs/10 管理命令清单）─────────────────
// docs/10 对 /deluser 单独列了与 /purge 同型的三条边界；⑫/⑬ 与 ②/③ 同构但 action=deluser，
// 且拒绝路径额外断言墓碑未写（deluser 独有的「关门」副作用不得提前发生）。

describe('/deluser 专属 confirm 边界（S10 补齐 ⑥b–⑥d，docs/04 步骤 3）', () => {
  it('⑥b confirm 序号不匹配拒绝：零删除零墓碑、无执行 audit、提示作废（docs/04 步骤 3）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9941, { watchlisted: 1 });
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2011);
    await seedMessage(conversationId, 2011, 7011);
    await handleCommand(ctxFor(commandUpdate(7031, 7031, ADMIN_ID, '/deluser', 2011), makeTelegram(dangerOkStubs()).telegram));

    const { telegram, calls } = makeTelegram(noticeOnlyStubs()); // 删消息/删 Topic 未编排 = 不得发生
    await handleCommand(
      ctxFor(commandUpdate(7032, 7032, ADMIN_ID, `/deluser confirm ${customerId + 100}`, 2011), telegram),
    );

    // 零删除 + 墓碑未写（关门不得在拒绝路径发生）
    expect(await customerRow(BOT_ID, 9941)).not.toBeNull();
    expect(await conversationsCount(customerId)).toBe(1);
    expect(await messagesCount(conversationId)).toBe(1);
    expect(await tombstoneRow(BOT_ID, 9941)).toBeNull();

    // 仅发起审计一条，无 confirmed 执行行
    const audits = auditsForCustomer(await auditRows('deluser'), customerId);
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]?.detail_json ?? '{}').confirmed).toBeUndefined();

    // 拒绝提示（不发删除类外呼）
    expect(callsOf(calls, 'sendMessage')).toHaveLength(1);
    expect(callsOf(calls, 'sendMessage')[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 2011,
      text: CONFIRM_MISMATCH_NOTICE,
    });
  });

  it('⑥c confirm 超时拒绝（种子发起 audit 11min 前）：零删除零墓碑、提示作废、无执行 audit（docs/04 步骤 3）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9942);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2012);
    await seedMessage(conversationId, 2012, 7012);
    await seedIntentAudit('deluser', customerId, 9942, minutesAgoIso(11)); // 超出 10 分钟窗口

    const { telegram, calls } = makeTelegram(noticeOnlyStubs());
    await handleCommand(
      ctxFor(commandUpdate(7033, 7033, ADMIN_ID, `/deluser confirm ${customerId}`, 2012), telegram),
    );

    expect(await customerRow(BOT_ID, 9942)).not.toBeNull();
    expect(await conversationsCount(customerId)).toBe(1);
    expect(await messagesCount(conversationId)).toBe(1);
    expect(await tombstoneRow(BOT_ID, 9942)).toBeNull();
    const audits = auditsForCustomer(await auditRows('deluser'), customerId);
    expect(audits).toHaveLength(1); // 只有种子发起行，无执行审计
    expect(JSON.parse(audits[0]?.detail_json ?? '{}').confirmed).toBeUndefined();
    expect(callsOf(calls, 'sendMessage')).toHaveLength(1);
    expect(callsOf(calls, 'sendMessage')[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 2012,
      text: CONFIRM_EXPIRED_NOTICE,
    });
  });

  it('⑥d 重复 confirm 幂等：customer 已删 → 反查失败静默（零外呼、墓碑保留、无新 audit）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9943);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 2013);
    await seedMessage(conversationId, 2013, 7013);
    await executeDeluser(customerId, 2013, 7034);
    expect(await customerRow(BOT_ID, 9943)).toBeNull(); // 前置：已成功删除

    // 空桩：任何外呼都会抛错；customer 已删 → thread 反查失败必须整体静默
    const { telegram, calls } = makeTelegram({});
    await expect(
      handleCommand(ctxFor(commandUpdate(7036, 7036, ADMIN_ID, `/deluser confirm ${customerId}`, 2013), telegram)),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    expect(await customerRow(BOT_ID, 9943)).toBeNull();
    expect(await tombstoneRow(BOT_ID, 9943)).not.toBeNull(); // 墓碑未被重复 confirm 触碰
    expect(await conversationsCount(customerId)).toBe(0);
    expect(await messagesCount(conversationId)).toBe(0);
    expect(auditsForCustomer(await auditRows('deluser'), customerId)).toHaveLength(2); // 发起 + 执行，不追加
  });
});
