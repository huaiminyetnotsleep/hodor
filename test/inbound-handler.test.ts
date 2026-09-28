import { beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { allowUnknownUsers, handleInbound } from '../src/pipeline/inbound';
import { TITLE_MAX_LENGTH, renderDisplayName, renderTitle } from '../src/domain';
import { WATCH_NOTICE, renderWelcome } from '../src/domain/copy';
import type { UpdateContext } from '../src/domain';
import { processUpdate, registerUpdate, resolveMaxAttempts } from '../src/inbox';
import type { TelegramClient, TelegramUpdate } from '../src/telegram';
import type { Bot } from '../src/store';
import { callsOf, makeTelegram, type MethodStub } from './telegram-stub';

// design.md 测试设计 12 用例（①–⑫）+ 2 条补充（⑬ 毒丸 processed、⑭ A/B 不串线）。
// 真 D1（cloudflare-pool + 本文件隔离存储）+ 桩 telegram client：
// createTelegramClient({ botToken, fetchImpl: 桩 })——桩见 ./telegram-stub.ts（与出站套件共用）。
// 入站链路状态机语义另见 inbox-machine.test.ts。

const db = env.DB;
const BOT_ID = 1;
const SUPPORT_CHAT_ID = -100555001;

const BOT: Bot = {
  id: BOT_ID,
  telegram_bot_id: 4301,
  webhook_key: 'k-inbound-test-bot',
  encrypted_bot_token: null,
  webhook_secret_hash: 'sha256hex',
  support_chat_id: SUPPORT_CHAT_ID,
  status: 'active',
  config_version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

// ── telegram 桩（docs/10：fetch 层打桩；makeTelegram/callsOf 共用于 ./telegram-stub.ts）──

/** 全链路编排桩：thread/message id 由调用方固定，便于与落库行断言 */
const fullChainStubs = (threadId: number, copiedId: number): Record<string, MethodStub> => ({
  createForumTopic: () => ({ message_thread_id: threadId }),
  copyMessage: () => ({ message_id: copiedId }),
  sendMessage: () => ({ message_id: copiedId + 1000 }),
});

// ── Update 构造（docs/03 判空原则：只给链路消费的字段）────────────────────────

function textUpdate(updateId: number, userId: number, text: string, firstName = 'Nick'): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: firstName },
      chat: { id: userId, type: 'private' },
      date: 1760000000,
      text,
    },
  };
}

function photoUpdate(updateId: number, userId: number, caption: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'Nick' },
      chat: { id: userId, type: 'private' },
      date: 1760000000,
      caption,
      photo: [
        { file_id: 'photo-small', width: 90, height: 90 },
        { file_id: 'photo-big', width: 1280, height: 720 },
      ],
    },
  };
}

function ctxFor(update: TelegramUpdate, telegram: TelegramClient, allowUnknown: string = 'true'): UpdateContext {
  return { env: { ...env, ALLOW_UNKNOWN_USERS: allowUnknown }, db, telegram, bot: BOT, update };
}

// ── DB 视图与种子 ────────────────────────────────────────────────────────────

interface CustomerView {
  id: number;
  display_name: string | null;
  username: string | null;
  blocked: number;
  bot_blocked_by_user: number;
  watchlisted: number;
}

async function customerRow(telegramUserId: number): Promise<CustomerView | null> {
  return db
    .prepare(
      'SELECT id, display_name, username, blocked, bot_blocked_by_user, watchlisted FROM customers WHERE bot_id = ? AND telegram_user_id = ?',
    )
    .bind(BOT_ID, telegramUserId)
    .first<CustomerView>();
}

interface ConversationView {
  id: number;
  message_thread_id: number | null;
  status: string;
  canonical_title: string | null;
}

async function conversationsOfCustomer(customerId: number): Promise<ConversationView[]> {
  const res = await db
    .prepare('SELECT id, message_thread_id, status, canonical_title FROM conversations WHERE customer_id = ? ORDER BY id')
    .bind(customerId)
    .all<ConversationView>();
  return res.results;
}

interface MessageView {
  direction: string;
  source_chat_id: number | null;
  source_message_id: number | null;
  target_chat_id: number | null;
  target_message_id: number | null;
  message_thread_id: number | null;
  content_type: string;
  text_content: string | null;
  media_file_id: string | null;
}

async function messagesOfConversation(conversationId: number): Promise<MessageView[]> {
  const res = await db
    .prepare(
      'SELECT direction, source_chat_id, source_message_id, target_chat_id, target_message_id, message_thread_id, content_type, text_content, media_file_id FROM messages WHERE conversation_id = ? ORDER BY id',
    )
    .bind(conversationId)
    .all<MessageView>();
  return res.results;
}

async function tombstoneRow(telegramUserId: number): Promise<{ was_watchlisted: number } | null> {
  return db
    .prepare('SELECT was_watchlisted FROM deleted_users WHERE bot_id = ? AND telegram_user_id = ?')
    .bind(BOT_ID, telegramUserId)
    .first<{ was_watchlisted: number }>();
}

async function auditRows(action: string): Promise<{ detail_json: string | null }[]> {
  const res = await db
    .prepare('SELECT detail_json FROM audit_logs WHERE bot_id = ? AND action = ? ORDER BY id')
    .bind(BOT_ID, action)
    .all<{ detail_json: string | null }>();
  return res.results;
}

async function inboxRow(updateId: number): Promise<{ status: string; attempts: number; last_error: string | null } | null> {
  return db
    .prepare('SELECT status, attempts, last_error FROM inbox_updates WHERE bot_id = ? AND telegram_update_id = ?')
    .bind(BOT_ID, updateId)
    .first<{ status: string; attempts: number; last_error: string | null }>();
}

const SEED_TS = '2026-01-02T00:00:00Z';

async function seedCustomer(options: {
  telegramUserId: number;
  displayName?: string;
  blocked?: number;
  botBlocked?: number;
}): Promise<number> {
  await db
    .prepare(
      'INSERT INTO customers (bot_id, telegram_user_id, display_name, blocked, bot_blocked_by_user, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(BOT_ID, options.telegramUserId, options.displayName ?? 'Nick', options.blocked ?? 0, options.botBlocked ?? 0, SEED_TS, SEED_TS)
    .run();
  const row = await customerRow(options.telegramUserId);
  return row!.id;
}

async function seedOpenConversation(customerId: number, threadId: number, title: string): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO conversations (bot_id, customer_id, support_chat_id, message_thread_id, status, canonical_title, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)",
    )
    .bind(BOT_ID, customerId, SUPPORT_CHAT_ID, threadId, title, SEED_TS, SEED_TS)
    .run();
  return res.meta.last_row_id;
}

async function seedCreatingConversation(customerId: number): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO conversations (bot_id, customer_id, support_chat_id, status, created_at, updated_at) VALUES (?, ?, ?, 'creating', ?, ?)",
    )
    .bind(BOT_ID, customerId, SUPPORT_CHAT_ID, SEED_TS, SEED_TS)
    .run();
  return res.meta.last_row_id;
}

async function seedTombstone(telegramUserId: number, wasWatchlisted: number): Promise<void> {
  await db
    .prepare('INSERT INTO deleted_users (bot_id, telegram_user_id, was_watchlisted, deleted_at) VALUES (?, ?, ?, ?)')
    .bind(BOT_ID, telegramUserId, wasWatchlisted, SEED_TS)
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await db
    .prepare(
      "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (4301, 'k-inbound-test-bot', 'sha256hex', -100555001, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .run();
});

// ── design.md 测试设计 12 用例 ───────────────────────────────────────────────

describe('handleInbound 全链路（design.md 测试设计 ①–⑫）', () => {
  it('① 新用户全链路：建户 → 建题 → copy → 落库 → WELCOME', async () => {
    const { telegram, calls } = makeTelegram(fullChainStubs(501, 9001));
    await handleInbound(ctxFor(textUpdate(1001, 8801, 'hello hodor'), telegram));

    const customer = await customerRow(8801);
    expect(customer).not.toBeNull();
    expect(customer?.display_name).toBe('Nick');
    expect(customer?.blocked).toBe(0);
    expect(customer?.watchlisted).toBe(0);

    const expectedTitle = `👤 Nick 8801 · #${customer!.id}`;
    const convs = await conversationsOfCustomer(customer!.id);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ status: 'open', message_thread_id: 501, canonical_title: expectedTitle });

    const topicCalls = callsOf(calls, 'createForumTopic');
    expect(topicCalls).toHaveLength(1);
    expect(topicCalls[0]?.payload).toEqual({ chat_id: SUPPORT_CHAT_ID, name: expectedTitle });

    const copyCalls = callsOf(calls, 'copyMessage');
    expect(copyCalls).toHaveLength(1);
    // from = 用户私聊，to = (支持群, Topic)（docs/10「中继」：copyMessage 参数正确）
    expect(copyCalls[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      from_chat_id: 8801,
      message_id: 1001,
      message_thread_id: 501,
    });

    const sendCalls = callsOf(calls, 'sendMessage');
    expect(sendCalls).toHaveLength(1); // WELCOME（仅 isNew）
    expect(sendCalls[0]?.payload.chat_id).toBe(8801);
    expect(String(sendCalls[0]?.payload.text)).toContain(`#${customer!.id}`);

    const msgs = await messagesOfConversation(convs[0]!.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      direction: 'inbound',
      source_chat_id: 8801,
      source_message_id: 1001,
      target_chat_id: SUPPORT_CHAT_ID,
      target_message_id: 9001,
      message_thread_id: 501,
      content_type: 'text',
      text_content: 'hello hodor',
      media_file_id: null,
    });
  });

  it('② 老用户不重复建题、不重复 WELCOME', async () => {
    const first = makeTelegram(fullChainStubs(601, 9101));
    await handleInbound(ctxFor(textUpdate(1101, 8802, 'first'), first.telegram));
    const second = makeTelegram(fullChainStubs(602, 9102));
    await handleInbound(ctxFor(textUpdate(1102, 8802, 'second'), second.telegram));

    const customer = await customerRow(8802);
    const convs = await conversationsOfCustomer(customer!.id);
    expect(convs).toHaveLength(1); // 复用 open 会话
    expect(callsOf(second.calls, 'createForumTopic')).toHaveLength(0);
    expect(callsOf(second.calls, 'sendMessage')).toHaveLength(0); // WELCOME 只发一次
    expect(callsOf(second.calls, 'copyMessage')).toHaveLength(1);
    expect(await messagesOfConversation(convs[0]!.id)).toHaveLength(2);
  });

  it('③ 墓碑非 /start → 静默（不建户不建题零外呼，墓碑保留）', async () => {
    await seedTombstone(8803, 1);
    const { telegram, calls } = makeTelegram(fullChainStubs(503, 9003));

    await expect(handleInbound(ctxFor(textUpdate(1201, 8803, 'hi'), telegram))).resolves.toBeUndefined();

    expect(await customerRow(8803)).toBeNull();
    expect(await tombstoneRow(8803)).not.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('④ /start 复活：删墓碑 → 全新客户继承 was_watchlisted → 建题（⚠️）+ WELCOME', async () => {
    await seedTombstone(8804, 1);
    const { telegram, calls } = makeTelegram(fullChainStubs(504, 9004));

    await handleInbound(ctxFor(textUpdate(1301, 8804, '/start'), telegram));

    expect(await tombstoneRow(8804)).toBeNull();
    const customer = await customerRow(8804);
    expect(customer).not.toBeNull();
    expect(customer?.watchlisted).toBe(1); // 继承墓碑 was_watchlisted

    const convs = await conversationsOfCustomer(customer!.id);
    expect(convs).toHaveLength(1);
    expect(convs[0]?.canonical_title).toBe(`⚠️ Nick 8804 · #${customer!.id}`);
    // 两条 sendMessage：WELCOME（复活按全新用户，发用户私聊）+ WATCH_NOTICE（继承高危 →
    // last_watch_notice_at 为 NULL 首次入站即提示，docs/03 步骤 11，S7）
    const sendCalls = callsOf(calls, 'sendMessage');
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]?.payload).toMatchObject({ chat_id: 8804, text: renderWelcome(customer!.id) });
    expect(sendCalls[1]?.payload).toMatchObject({ chat_id: SUPPORT_CHAT_ID, message_thread_id: 504, text: WATCH_NOTICE });
  });

  it('⑤ blocked → 静默（拒绝服务不是故障，零外呼零建题）', async () => {
    const customerId = await seedCustomer({ telegramUserId: 8805, blocked: 1 });
    const { telegram, calls } = makeTelegram(fullChainStubs(505, 9005));

    await expect(handleInbound(ctxFor(textUpdate(1401, 8805, 'hello'), telegram))).resolves.toBeUndefined();

    expect(await conversationsOfCustomer(customerId)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('⑥ bot_blocked_by_user 复位（用户回归；不建新题照常中继）', async () => {
    const customerId = await seedCustomer({ telegramUserId: 8806, botBlocked: 1 });
    const conversationId = await seedOpenConversation(customerId, 706, `👤 Nick 8806 · #${customerId}`);
    const { telegram, calls } = makeTelegram(fullChainStubs(606, 9006));

    await handleInbound(ctxFor(textUpdate(1501, 8806, 'back'), telegram));

    expect((await customerRow(8806))?.bot_blocked_by_user).toBe(0);
    expect(callsOf(calls, 'createForumTopic')).toHaveLength(0);
    expect(callsOf(calls, 'copyMessage')).toHaveLength(1);
    expect(await messagesOfConversation(conversationId)).toHaveLength(1);
  });

  it('⑦ 改名刷新：editForumTopic 全量重渲染 + canonical_title 同步（不新建题）', async () => {
    const customerId = await seedCustomer({ telegramUserId: 8807, displayName: 'OldName' });
    await seedOpenConversation(customerId, 707, `👤 OldName 8807 · #${customerId}`);
    const { telegram, calls } = makeTelegram({ ...fullChainStubs(607, 9007), editForumTopic: () => true });

    await handleInbound(ctxFor(textUpdate(1601, 8807, 'hello', 'NewName'), telegram));

    expect((await customerRow(8807))?.display_name).toBe('NewName');
    const convs = await conversationsOfCustomer(customerId);
    expect(convs[0]?.canonical_title).toBe(`👤 NewName 8807 · #${customerId}`);
    expect(callsOf(calls, 'createForumTopic')).toHaveLength(0);
    const editCalls = callsOf(calls, 'editForumTopic');
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 707,
      name: `👤 NewName 8807 · #${customerId}`,
    });
  });

  it('⑨ creating 残留重试：复用会话行 + 标记消息（#序号+时间戳）+ audit topic_creation_retry', async () => {
    const customerId = await seedCustomer({ telegramUserId: 8809 });
    const conversationId = await seedCreatingConversation(customerId);
    const { telegram, calls } = makeTelegram(fullChainStubs(709, 9009));

    await handleInbound(ctxFor(textUpdate(1701, 8809, 'hello'), telegram));

    const convs = await conversationsOfCustomer(customerId);
    expect(convs).toHaveLength(1); // 复用 creating 残留行，不新建
    expect(convs[0]?.id).toBe(conversationId);
    expect(convs[0]).toMatchObject({ status: 'open', message_thread_id: 709 });

    const markerCalls = callsOf(calls, 'sendMessage');
    expect(markerCalls).toHaveLength(1); // 标记消息（老用户无 WELCOME）
    expect(markerCalls[0]?.payload.chat_id).toBe(SUPPORT_CHAT_ID);
    expect(markerCalls[0]?.payload.message_thread_id).toBe(709);
    const markerText = String(markerCalls[0]?.payload.text);
    expect(markerText).toContain(`#${customerId}`);
    expect(markerText).toMatch(/\d{4}-\d{2}-\d{2}T/); // 时间戳

    const audits = await auditRows('topic_creation_retry');
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]?.detail_json ?? '{}')).toMatchObject({
      customer_id: customerId,
      conversation_id: conversationId,
      message_thread_id: 709,
    });
  });

  it('⑩ ALLOW_UNKNOWN_USERS=false：未知用户静默 + 审计 unknown_user_rejected（不建户不建题）', async () => {
    const { telegram, calls } = makeTelegram(fullChainStubs(510, 9010));

    await expect(handleInbound(ctxFor(textUpdate(1801, 8810, 'hello'), telegram, 'false'))).resolves.toBeUndefined();

    expect(await customerRow(8810)).toBeNull();
    expect(calls).toHaveLength(0);
    const audits = await auditRows('unknown_user_rejected');
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]?.detail_json ?? '{}')).toMatchObject({ telegram_user_id: 8810 });
  });

  it('⑪ 媒体消息落库：photo 取最高分辨率 file_id，caption 入 text_content', async () => {
    const { telegram, calls } = makeTelegram(fullChainStubs(711, 9011));

    await handleInbound(ctxFor(photoUpdate(1901, 8811, '看这张'), telegram));

    const customer = await customerRow(8811);
    const convs = await conversationsOfCustomer(customer!.id);
    const msgs = await messagesOfConversation(convs[0]!.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      direction: 'inbound',
      content_type: 'photo',
      text_content: '看这张',
      media_file_id: 'photo-big',
    });
    expect(callsOf(calls, 'copyMessage')).toHaveLength(1); // 媒体本体由 Telegram 原样复制（docs/03）
  });

  it('⑫ createForumTopic permanent → 抛出 → 状态机 5xx（creating 残留留给重试路径）', async () => {
    const update = textUpdate(2001, 8812, 'hello');
    const registration = await registerUpdate(db, BOT_ID, update);
    const { telegram } = makeTelegram({
      createForumTopic: () => ({ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }),
    });

    const result = await processUpdate(ctxFor(update, telegram), registration, handleInbound, resolveMaxAttempts('8'));

    expect(result.httpStatus).toBe(500); // → Telegram 重投（重试路径即崩溃窗口预案入口）
    expect(result.rowStatus).toBe('pending');
    const row = await inboxRow(2001);
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain('createForumTopic failed (permanent)');

    const customer = await customerRow(8812);
    expect(customer).not.toBeNull();
    const convs = await conversationsOfCustomer(customer!.id);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ status: 'creating', message_thread_id: null }); // 意图已落库
  });

  it('⑬ 补充：copyMessage permanent（400 毒丸）→ 记 last_error + processed，不进重试（docs/03）', async () => {
    const customerId = await seedCustomer({ telegramUserId: 8813 });
    await seedOpenConversation(customerId, 713, `👤 Nick 8813 · #${customerId}`);
    const update = textUpdate(2101, 8813, 'hello');
    const registration = await registerUpdate(db, BOT_ID, update);
    const { telegram, calls } = makeTelegram({
      copyMessage: () => ({ status: 400, body: { ok: false, description: 'Bad Request: message to copy not found' } }),
    });

    const result = await processUpdate(ctxFor(update, telegram), registration, handleInbound, resolveMaxAttempts('8'));

    expect(result.httpStatus).toBe(200);
    expect(result.rowStatus).toBe('processed');
    const row = await inboxRow(2101);
    expect(row?.status).toBe('processed');
    expect(row?.last_error).toContain('copyMessage permanent');
    expect(await messagesOfConversation((await conversationsOfCustomer(customerId))[0]!.id)).toHaveLength(0);
    expect(callsOf(calls, 'sendMessage')).toHaveLength(0);
  });

  it('⑭ 补充：用户 A/B 不串线（各自 Topic 与 messages 映射，docs/10）', async () => {
    const a = makeTelegram(fullChainStubs(714, 9014));
    const b = makeTelegram(fullChainStubs(715, 9015));
    await handleInbound(ctxFor(textUpdate(2201, 8814, 'from A'), a.telegram));
    await handleInbound(ctxFor(textUpdate(2202, 8815, 'from B'), b.telegram));

    const customerA = await customerRow(8814);
    const customerB = await customerRow(8815);
    const convA = (await conversationsOfCustomer(customerA!.id))[0]!;
    const convB = (await conversationsOfCustomer(customerB!.id))[0]!;
    expect(convA.id).not.toBe(convB.id);
    expect(convA.message_thread_id).not.toBe(convB.message_thread_id);

    expect((await messagesOfConversation(convA.id))[0]?.text_content).toBe('from A');
    expect((await messagesOfConversation(convB.id))[0]?.text_content).toBe('from B');
  });
});

// ── 纯函数（design.md 语义 5 + docs/09 解析规则）────────────────────────────

describe('renderTitle / renderDisplayName / allowUnknownUsers（纯函数）', () => {
  it('⑧ 128 字符预算：先扣固定部分再截断 display_name（截断只落在名字上）', () => {
    const longName = '中'.repeat(300);
    const title = renderTitle({
      customerId: 424242,
      telegramUserId: 987654321,
      displayName: longName,
      blocked: false,
      watchlisted: false,
    });
    const suffix = ' 987654321 · #424242';
    expect(TITLE_MAX_LENGTH).toBe(128);
    expect(title.length).toBe(TITLE_MAX_LENGTH); // ID 永远完整，总长压线 128
    expect(title.startsWith('👤 ')).toBe(true);
    expect(title.endsWith(suffix)).toBe(true);
    expect(title).toBe(`👤 ${longName.slice(0, TITLE_MAX_LENGTH - '👤 '.length - suffix.length)}${suffix}`);
  });

  it('标题图标优先级：🔇（blocked）> ⚠️（watchlisted）> 👤（docs/02）', () => {
    const base = { customerId: 1, telegramUserId: 2, displayName: 'A' };
    expect(renderTitle({ ...base, blocked: true, watchlisted: true }).startsWith('🔇')).toBe(true);
    expect(renderTitle({ ...base, blocked: false, watchlisted: true }).startsWith('⚠️')).toBe(true);
    expect(renderTitle({ ...base, blocked: false, watchlisted: false }).startsWith('👤')).toBe(true);
  });

  it('renderDisplayName 回退链：first last → username → id（判空，永不空串）', () => {
    expect(renderDisplayName({ id: 5, first_name: 'A', last_name: 'B' })).toBe('A B');
    expect(renderDisplayName({ id: 5, first_name: '', username: 'u5' })).toBe('u5');
    expect(renderDisplayName({ id: 5, first_name: '' })).toBe('5');
  });

  it('allowUnknownUsers：仅显式 "false" 关闭，缺省/其他值一律开放（docs/09）', () => {
    expect(allowUnknownUsers('false')).toBe(false);
    expect(allowUnknownUsers(undefined)).toBe(true);
    expect(allowUnknownUsers('true')).toBe(true);
    expect(allowUnknownUsers('FALSE')).toBe(true);
    expect(allowUnknownUsers('')).toBe(true);
  });
});
