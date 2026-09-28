import { beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { getCommandHandler, handleCommand, parseCommand } from '../src/pipeline/commands';
import { handleInbound } from '../src/pipeline/inbound';
import { classifyUpdate, getUpdateHandler } from '../src/domain';
import type { UpdateContext } from '../src/domain';
import { processUpdate, registerUpdate, resolveMaxAttempts } from '../src/inbox';
import type { TelegramClient, TelegramUpdate } from '../src/telegram';
import type { Bot } from '../src/store';
import { callsOf, makeTelegram, type MethodStub } from './telegram-stub';

// design.md 测试设计（S6）：①白名单外 /ban 零副作用 ②/ban 全链路（flag→🔇 标题→删消息→audit）
// ③ban 后入站静默 processed ④/unban 恢复（👤 / ⚠️ 按 watchlisted）⑤/unban 对 closed 会话 reopen
// ⑥未知命令静默 ⑦命令不进 copyMessage ⑧thread 无会话 /ban 静默 + parseCommand 纯函数单测。
// 真 D1（cloudflare-pool + 本文件隔离存储）+ 桩 telegram client（makeTelegram 与入站/出站套件共用）。

const db = env.DB;
const BOT_ID = 1;
const SUPPORT_CHAT_ID = -100666001;
const ADMIN_ID = 8801;
const OUTSIDER_ID = 8802;

const BOT: Bot = {
  id: BOT_ID,
  telegram_bot_id: 4401,
  webhook_key: 'k-admin-commands-test-bot',
  encrypted_bot_token: null,
  webhook_secret_hash: 'sha256hex',
  support_chat_id: SUPPORT_CHAT_ID,
  status: 'active',
  config_version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

// ── telegram 桩（docs/10：fetch 层打桩；未编排 method 抛错 = 「不得发生」断言）──────────

/** 命令链路正常桩：editForumTopic / deleteMessage / reopenForumTopic 全部成功（closeForumTopic 有意不编排） */
const commandOkStubs = (): Record<string, MethodStub> => ({
  editForumTopic: () => true,
  deleteMessage: () => true,
  reopenForumTopic: () => true,
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
}

async function customerRow(botId: number, telegramUserId: number): Promise<CustomerView | null> {
  return db
    .prepare('SELECT id, blocked, watchlisted FROM customers WHERE bot_id = ? AND telegram_user_id = ?')
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

async function seedCustomer(botId: number, telegramUserId: number, watchlisted = 0): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO customers (bot_id, telegram_user_id, display_name, watchlisted, created_at, updated_at) VALUES (?, ?, 'Nick', ?, ?, ?)",
    )
    .bind(botId, telegramUserId, watchlisted, SEED_TS, SEED_TS)
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
  // 幂等种子：同一 (bot_id, telegram_user_id) 重复 seeding 是无害 no-op（UNIQUE 约束）
  await db
    .prepare('INSERT OR IGNORE INTO support_admins (bot_id, telegram_user_id, display_name, created_at) VALUES (?, ?, ?, ?)')
    .bind(botId, telegramUserId, 'Admin', SEED_TS)
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await db
    .prepare(
      "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (4401, 'k-admin-commands-test-bot', 'sha256hex', -100666001, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .run();
  // 全套件共用白名单管理员（docs/04 步骤 1 前置）；用例 ① 用 OUTSIDER_ID 单独测白名单外分支
  await seedAdmin(BOT_ID, ADMIN_ID);
});

// ── parseCommand 纯函数单测（design.md：@bot 后缀、参数、大小写、非命令 null）────────

describe('parseCommand 纯函数', () => {
  it('/cmd → name + 空 args', () => {
    expect(parseCommand('/ban')).toEqual({ name: 'ban', args: '' });
  });

  it('/cmd@BotName → @ 后缀剥离', () => {
    expect(parseCommand('/ban@HodorBot')).toEqual({ name: 'ban', args: '' });
    expect(parseCommand('/unban@HodorBot now')).toEqual({ name: 'unban', args: 'now' });
  });

  it('/cmd args... → 参数保留（仅去前导空白）', () => {
    expect(parseCommand('/ban skip extra')).toEqual({ name: 'ban', args: 'skip extra' });
    expect(parseCommand('/ban   spaced')).toEqual({ name: 'ban', args: 'spaced' });
  });

  it('命令名大小写不敏感 → 小写规范名', () => {
    expect(parseCommand('/BAN')).toEqual({ name: 'ban', args: '' });
    expect(parseCommand('/UnBan@HodorBot')).toEqual({ name: 'unban', args: '' });
  });

  it('非命令文本 / 裸 `/` / `/@Bot` → null', () => {
    expect(parseCommand('hello /ban')).toBeNull(); // 非 / 前缀
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/@HodorBot')).toBeNull(); // 无命令名
    expect(parseCommand('')).toBeNull();
  });

  it('注册表：docs/04 命令全集（S6 ban / unban + S7 risk / unrisk + S8 purge / deluser）', () => {
    expect(getCommandHandler('ban')).toBeDefined();
    expect(getCommandHandler('unban')).toBeDefined();
    expect(getCommandHandler('risk')).toBeDefined(); // S7
    expect(getCommandHandler('unrisk')).toBeDefined(); // S7
    expect(getCommandHandler('purge')).toBeDefined(); // S8
    expect(getCommandHandler('deluser')).toBeDefined(); // S8
    expect(getCommandHandler('nonexistent')).toBeUndefined();
  });
});

// ── design.md 测试设计 ①–⑧ ──────────────────────────────────────────────────

describe('handleCommand 管理命令（design.md 测试设计）', () => {
  it('① 白名单外 /ban 零副作用（不删消息、零外呼、不写库、不审计，docs/04 步骤 1）', async () => {
    const customerId = await seedCustomer(BOT_ID, 7701);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 901);
    const auditBefore = (await auditRows('ban')).length;
    const { telegram, calls } = makeTelegram(commandOkStubs());
    const update = commandUpdate(4001, 4001, OUTSIDER_ID, '/ban', 901);

    await expect(handleCommand(ctxFor(update, telegram))).resolves.toBeUndefined();

    expect(calls).toHaveLength(0); // 不删消息、零外呼（白名单先于解析/删除）
    expect((await customerRow(BOT_ID, 7701))?.blocked).toBe(0); // 不写库
    expect((await auditRows('ban')).length).toBe(auditBefore); // 不审计
    expect(await messagesCount(conversationId)).toBe(0);
  });

  it('② /ban 全链路：flag=1 → 🔇 标题重渲染 → deleteMessage → audit 行字段（docs/04 步骤 4–9）', async () => {
    const customerId = await seedCustomer(BOT_ID, 7702);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 902);
    const { telegram, calls } = makeTelegram(commandOkStubs());

    await expect(handleCommand(ctxFor(commandUpdate(4002, 4002, ADMIN_ID, '/ban', 902), telegram))).resolves
      .toBeUndefined();

    // 步骤 4：blocked 唯一事实源写入
    expect((await customerRow(BOT_ID, 7702))?.blocked).toBe(1);

    // 步骤 5：标题全量重渲染 🔇（docs/02：绝不在旧标题上追加）+ canonical_title 同步
    const edits = callsOf(calls, 'editForumTopic');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 902,
      name: `🔇 Nick 7702 · #${customerId}`,
    });
    expect((await conversationRow(conversationId))?.canonical_title).toBe(`🔇 Nick 7702 · #${customerId}`);
    expect((await conversationRow(conversationId))?.status).toBe('open');

    // CLOSE_TOPIC_ON_BAN 默认关：不 close（Topic 仍可发消息，服务提示可达，docs/04 步骤 6）
    expect(callsOf(calls, 'closeForumTopic')).toHaveLength(0);

    // 步骤 7：命令消息删除（用户侧不可见）
    const deletes = callsOf(calls, 'deleteMessage');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.payload).toEqual({ chat_id: SUPPORT_CHAT_ID, message_id: 4002 });

    // 步骤 9：audit ban（actor、target；detail 不含消息内容）
    const banAudits = auditsForCustomer(await auditRows('ban'), customerId);
    expect(banAudits).toHaveLength(1);
    expect(banAudits[0]).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, action: 'ban' });
    expect(JSON.parse(banAudits[0]?.detail_json ?? '{}')).toEqual({
      customer_id: customerId,
      telegram_user_id: 7702,
    });

    // 命令不是中继消息：不落 messages、不进 copyMessage
    expect(callsOf(calls, 'copyMessage')).toHaveLength(0);
    expect(await messagesCount(conversationId)).toBe(0);
  });

  it('③ ban 后用户入站 → 静默丢弃且标记 processed（拒绝服务不是故障，docs/03 blocked 路径）', async () => {
    const customerId = await seedCustomer(BOT_ID, 7703);
    await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 903);
    await handleCommand(ctxFor(commandUpdate(4003, 4003, ADMIN_ID, '/ban', 903), makeTelegram(commandOkStubs()).telegram));
    expect((await customerRow(BOT_ID, 7703))?.blocked).toBe(1);

    // 用户再次发消息 → 走幂等状态机断言 processed（复用 S4 模式 + docs/03「processed 而非 failed」）
    const update = privateTextUpdate(4103, 7703, 'still trying');
    const registration = await registerUpdate(db, BOT_ID, update);
    const { telegram, calls } = makeTelegram(commandOkStubs());

    const result = await processUpdate(ctxFor(update, telegram), registration, handleInbound, resolveMaxAttempts('8'));

    expect(result.httpStatus).toBe(200); // 不触发 Telegram 重投
    expect(result.rowStatus).toBe('processed');
    const row = await db
      .prepare('SELECT status FROM inbox_updates WHERE bot_id = ? AND telegram_update_id = ?')
      .bind(BOT_ID, 4103)
      .first<{ status: string }>();
    expect(row?.status).toBe('processed');
    expect(calls).toHaveLength(0); // 静默：零外呼零建题
  });

  it('④ /unban 恢复：watchlisted=0 → 👤 标题、不 reopen；watchlisted=1 → ⚠️（解封不移出名单）', async () => {
    // case A：watchlisted=0（完整 ban → unban 往返）
    const customerIdA = await seedCustomer(BOT_ID, 7704);
    const conversationIdA = await seedConversation(BOT_ID, customerIdA, SUPPORT_CHAT_ID, 904);
    await handleCommand(ctxFor(commandUpdate(4004, 4004, ADMIN_ID, '/ban', 904), makeTelegram(commandOkStubs()).telegram));
    expect((await customerRow(BOT_ID, 7704))?.blocked).toBe(1);

    const a = makeTelegram(commandOkStubs());
    await handleCommand(ctxFor(commandUpdate(4014, 4014, ADMIN_ID, '/unban', 904), a.telegram));

    expect((await customerRow(BOT_ID, 7704))?.blocked).toBe(0);
    const editsA = callsOf(a.calls, 'editForumTopic');
    expect(editsA).toHaveLength(1);
    expect(editsA[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 904,
      name: `👤 Nick 7704 · #${customerIdA}`,
    });
    expect(callsOf(a.calls, 'reopenForumTopic')).toHaveLength(0); // open 会话无需重开
    expect(callsOf(a.calls, 'deleteMessage')).toHaveLength(1);
    expect((await conversationRow(conversationIdA))?.status).toBe('open');
    const unbanAuditsA = auditsForCustomer(await auditRows('unban'), customerIdA);
    expect(unbanAuditsA).toHaveLength(1);
    expect(unbanAuditsA[0]).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, action: 'unban' });

    // case B：watchlisted=1 → ⚠️（⚠️ 优先级低于已解除的 🔇，docs/02）
    const customerIdB = await seedCustomer(BOT_ID, 7705, 1);
    await seedConversation(BOT_ID, customerIdB, SUPPORT_CHAT_ID, 905);
    const b = makeTelegram(commandOkStubs());
    await handleCommand(ctxFor(commandUpdate(4005, 4005, ADMIN_ID, '/unban', 905), b.telegram));

    expect((await customerRow(BOT_ID, 7705))?.blocked).toBe(0);
    expect((await customerRow(BOT_ID, 7705))?.watchlisted).toBe(1); // 高危标志独立不动（docs/04）
    expect(callsOf(b.calls, 'editForumTopic')[0]?.payload).toMatchObject({
      name: `⚠️ Nick 7705 · #${customerIdB}`,
    });
  });

  it('⑤ /unban 对 closed 会话：reopenForumTopic + 状态置回 open（docs/04 /unban 步骤 4）', async () => {
    const customerId = await seedCustomer(BOT_ID, 7706);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 906, 'closed');
    const { telegram, calls } = makeTelegram(commandOkStubs());

    await handleCommand(ctxFor(commandUpdate(4006, 4006, ADMIN_ID, '/unban', 906), telegram));

    const reopens = callsOf(calls, 'reopenForumTopic');
    expect(reopens).toHaveLength(1);
    expect(reopens[0]?.payload).toEqual({ chat_id: SUPPORT_CHAT_ID, message_thread_id: 906 });
    expect((await conversationRow(conversationId))?.status).toBe('open'); // D1 置回 open
    expect((await customerRow(BOT_ID, 7706))?.blocked).toBe(0);
  });

  it('⑤b /unban reopen retryable（502）→ 抛出重投：blocked 已清、会话保持 closed、不删消息不审计', async () => {
    const customerId = await seedCustomer(BOT_ID, 7710);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 910, 'closed');
    const auditBefore = (await auditRows('unban')).length;
    const { telegram, calls } = makeTelegram({
      ...commandOkStubs(),
      reopenForumTopic: () => ({ status: 502, body: { ok: false, description: 'Bad Gateway' } }),
    });

    // 临时故障 → 抛出 → inbox 5xx → Telegram 重投（整条 /unban 幂等重放，docs/03 错误分类）
    await expect(handleCommand(ctxFor(commandUpdate(4030, 4030, ADMIN_ID, '/unban', 910), telegram))).rejects.toThrow(
      /reopenForumTopic failed \(retryable\)/,
    );

    expect((await customerRow(BOT_ID, 7710))?.blocked).toBe(0); // 主链路已写（重放安全）
    expect((await conversationRow(conversationId))?.status).toBe('closed'); // D1 不领先于 Topic 实际状态
    expect(callsOf(calls, 'deleteMessage')).toHaveLength(0); // 失败的命令不留「消息消失但什么都没发生」假象
    expect((await auditRows('unban')).length).toBe(auditBefore); // 审计未达
  });

  it('⑤c /unban reopen permanent（403）→ 不阻断：解封生效、会话保持 closed、audit 仍写', async () => {
    const customerId = await seedCustomer(BOT_ID, 7711);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 911, 'closed');
    const { telegram, calls } = makeTelegram({
      ...commandOkStubs(),
      reopenForumTopic: () => ({ status: 403, body: { ok: false, description: 'Forbidden: topic not found' } }),
    });

    // permanent（Topic 已被手动删除等）：解封本身已生效，不阻断审计与删消息（design.md 失败语义）
    await expect(handleCommand(ctxFor(commandUpdate(4031, 4031, ADMIN_ID, '/unban', 911), telegram))).resolves
      .toBeUndefined();

    expect((await customerRow(BOT_ID, 7711))?.blocked).toBe(0);
    expect((await conversationRow(conversationId))?.status).toBe('closed'); // 保持 closed——用户下次入站自然建新题
    expect(callsOf(calls, 'deleteMessage')).toHaveLength(1); // 命令消息照删
    const unbanAudits = auditsForCustomer(await auditRows('unban'), customerId);
    expect(unbanAudits).toHaveLength(1);
    expect(unbanAudits[0]).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, action: 'unban' });
  });

  it('⑥ 未知命令 → 静默（不删消息不审计，docs/04）', async () => {
    const customerId = await seedCustomer(BOT_ID, 7707);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 907);
    const auditBefore = (await auditRows('purge')).length;
    const { telegram, calls } = makeTelegram(commandOkStubs());

    await handleCommand(ctxFor(commandUpdate(4007, 4007, ADMIN_ID, '/nonexistent', 907), telegram)); // 未注册命令

    expect(calls).toHaveLength(0); // 不删消息（保留在群内）、零外呼
    expect((await customerRow(BOT_ID, 7707))?.blocked).toBe(0);
    expect((await auditRows('purge')).length).toBe(auditBefore);
    expect(await messagesCount(conversationId)).toBe(0);
  });

  it('⑦ 命令不进 copyMessage：classify → command 分流 + 注册表挂载 handleCommand（docs/03）', async () => {
    const customerId = await seedCustomer(BOT_ID, 7708);
    const conversationId = await seedConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 908);
    const update = commandUpdate(4008, 4008, ADMIN_ID, '/ban', 908);
    expect(classifyUpdate(update, BOT.telegram_bot_id)).toBe('command'); // 命令先于中继（docs/03）
    expect(getUpdateHandler('command')).toBe(handleCommand); // 注册表挂载（S6）

    const { telegram, calls } = makeTelegram(commandOkStubs());
    await expect(getUpdateHandler('command')(ctxFor(update, telegram))).resolves.toBeUndefined();

    expect(callsOf(calls, 'copyMessage')).toHaveLength(0); // 绝不进入 copyMessage（docs/03）
    expect(await messagesCount(conversationId)).toBe(0);
    expect((await customerRow(BOT_ID, 7708))?.blocked).toBe(1); // 经注册表入口照常执行
  });

  it('⑧ thread 无会话映射 → /ban 静默（零外呼不审计，docs/04 步骤 2）', async () => {
    const auditBefore = (await auditRows('ban')).length;
    const { telegram, calls } = makeTelegram(commandOkStubs());

    await handleCommand(ctxFor(commandUpdate(4009, 4009, ADMIN_ID, '/ban', 999), telegram));

    expect(calls).toHaveLength(0);
    expect((await auditRows('ban')).length).toBe(auditBefore);
  });
});
