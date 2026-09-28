import { beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { handleOutbound } from '../src/pipeline/outbound';
import { handleInbound } from '../src/pipeline/inbound';
import { BOT_BLOCKED_NOTICE, BOT_UNBLOCKED_NOTICE, classifyUpdate, getUpdateHandler } from '../src/domain';
import type { UpdateContext } from '../src/domain';
import { processUpdate, registerUpdate, resolveMaxAttempts } from '../src/inbox';
import type { TelegramClient, TelegramUpdate } from '../src/telegram';
import type { Bot } from '../src/store';
import { callsOf, makeTelegram, type MethodStub } from './telegram-stub';

// design.md 测试设计（S5）：校验矩阵 4 分支各自 ignore、正常出站 copy 参数 + 落库 9 字段、
// 403 首次置位 + 提示一次、置位期不重复提示但仍尝试、恢复提示、命令文本不中继、429 → 5xx。
// 真 D1（cloudflare-pool + 本文件隔离存储）+ 桩 telegram client（makeTelegram 与入站套件共用）。
// 注意：outbound 处理器内的 getChatMember 缓存是模块级（Worker 隔离实例存活）——
// 「Bot 非管理员」用例使用独立 bot（不同 support_chat_id/telegram_bot_id），避免污染主 bot 的缓存键。

const db = env.DB;
const BOT_ID = 1;
const SUPPORT_CHAT_ID = -100555001;
const ADMIN_ID = 7701;
const OUTSIDER_ID = 7702;

const BOT: Bot = {
  id: BOT_ID,
  telegram_bot_id: 4301,
  webhook_key: 'k-outbound-test-bot',
  encrypted_bot_token: null,
  webhook_secret_hash: 'sha256hex',
  support_chat_id: SUPPORT_CHAT_ID,
  status: 'active',
  config_version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

/** 「Bot 非管理员」专用 bot：独立缓存键（chatId:userId），与主 bot 互不污染 */
const BOT_NON_ADMIN: Bot = { ...BOT, id: 2, telegram_bot_id: 4304, support_chat_id: -100555004 };

// ── telegram 桩（docs/10：fetch 层打桩；makeTelegram/callsOf 共用于 ./telegram-stub.ts）──

/** 出站链路正常桩：getChatMember 管理员 + copyMessage 成功 */
const outboundOkStubs = (copiedId: number): Record<string, MethodStub> => ({
  getChatMember: () => ({ status: 'administrator', user: { id: BOT.telegram_bot_id, is_bot: true, first_name: 'hodor' } }),
  copyMessage: () => ({ message_id: copiedId }),
});

/** 403 桩（docs/03：bot was blocked by the user；client 透传 error_code → errorCode = 403） */
const blocked403Stub: MethodStub = () => ({
  status: 403,
  body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
});

/** getChatMember 管理员桩（供只关心 copyMessage 行为的用例复用） */
const adminMemberStub: MethodStub = () => ({
  status: 'administrator',
  user: { id: BOT.telegram_bot_id, is_bot: true, first_name: 'hodor' },
});

// ── Update 构造（支持群 Topic 内管理员发言；docs/03 判空原则：只给链路消费的字段）────────

function topicTextUpdate(updateId: number, messageId: number, senderId: number, text: string, threadId: number): TelegramUpdate {
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

function topicPhotoUpdate(updateId: number, messageId: number, senderId: number, caption: string, threadId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: senderId, is_bot: false, first_name: 'Admin' },
      chat: { id: SUPPORT_CHAT_ID, type: 'supergroup' },
      date: 1760000000,
      message_thread_id: threadId,
      caption,
      photo: [
        { file_id: 'photo-small', width: 90, height: 90 },
        { file_id: 'photo-big', width: 1280, height: 720 },
      ],
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

function ctxFor(update: TelegramUpdate, telegram: TelegramClient, bot: Bot = BOT): UpdateContext {
  return { env: { ...env }, db, telegram, bot, update };
}// ── DB 视图与种子 ────────────────────────────────────────────────────────────

interface CustomerView {
  id: number;
  bot_blocked_by_user: number;
}

async function customerRow(botId: number, telegramUserId: number): Promise<CustomerView | null> {
  return db
    .prepare('SELECT id, bot_blocked_by_user FROM customers WHERE bot_id = ? AND telegram_user_id = ?')
    .bind(botId, telegramUserId)
    .first<CustomerView>();
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

async function inboxRow(updateId: number): Promise<{ status: string; attempts: number; last_error: string | null } | null> {
  return db
    .prepare('SELECT status, attempts, last_error FROM inbox_updates WHERE bot_id = ? AND telegram_update_id = ?')
    .bind(BOT_ID, updateId)
    .first<{ status: string; attempts: number; last_error: string | null }>();
}

const SEED_TS = '2026-01-02T00:00:00Z';

async function seedCustomer(botId: number, telegramUserId: number, botBlocked = 0): Promise<number> {
  const res = await db
    .prepare(
      'INSERT INTO customers (bot_id, telegram_user_id, display_name, bot_blocked_by_user, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(botId, telegramUserId, 'Nick', botBlocked, SEED_TS, SEED_TS)
    .run();
  return res.meta.last_row_id;
}

async function seedOpenConversation(botId: number, customerId: number, supportChatId: number, threadId: number): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO conversations (bot_id, customer_id, support_chat_id, message_thread_id, status, canonical_title, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)",
    )
    .bind(botId, customerId, supportChatId, threadId, `👤 Nick ${customerId}`, SEED_TS, SEED_TS)
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

/** 主 bot 完整有效场景种子：客户 + open 会话 + 白名单管理员，返回 conversationId */
async function seedValidTopic(customerTgId: number, threadId: number, botBlocked = 0, bot: Bot = BOT): Promise<number> {
  const customerId = await seedCustomer(bot.id, customerTgId, botBlocked);
  const conversationId = await seedOpenConversation(bot.id, customerId, bot.support_chat_id, threadId);
  await seedAdmin(bot.id, ADMIN_ID);
  return conversationId;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await db
    .prepare(
      "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (4301, 'k-outbound-test-bot', 'sha256hex', -100555001, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (4304, 'k-outbound-test-bot-2', 'sha256hex', -100555004, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .run();
});

// ── design.md 测试设计 ───────────────────────────────────────────────────────

describe('handleOutbound 出站链路（design.md 测试设计）', () => {
  it('① 群 ID 不符 → 静默（零外呼；support_chat_id 校验先行）', async () => {
    const { telegram, calls } = makeTelegram(outboundOkStubs(9001));
    const update: TelegramUpdate = {
      update_id: 3001,
      message: {
        message_id: 3001,
        from: { id: ADMIN_ID, is_bot: false, first_name: 'Admin' },
        chat: { id: -100999999, type: 'supergroup' }, // ≠ support_chat_id
        date: 1760000000,
        message_thread_id: 899,
        text: 'wrong group',
      },
    };

    await expect(handleOutbound(ctxFor(update, telegram))).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
  });

  it('② thread 无会话 → 静默（零外呼零落库；未知 thread 不中继，docs/03）', async () => {
    await seedAdmin(BOT_ID, ADMIN_ID); // 越过 ③ 的干扰项隔离 ②：thread 反查失败即返回
    const { telegram, calls } = makeTelegram(outboundOkStubs(9002));
    const update = topicTextUpdate(3002, 3002, ADMIN_ID, 'unknown thread', 999); // 无会话映射

    await expect(handleOutbound(ctxFor(update, telegram))).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
  });

  it('③ 非白名单发送者 → 静默（零外呼零落库，docs/03 场景 15）', async () => {
    const conversationId = await seedValidTopic(9907, 817);
    const { telegram, calls } = makeTelegram(outboundOkStubs(9003));
    const update = topicTextUpdate(3003, 3003, OUTSIDER_ID, 'not whitelisted', 817);

    await expect(handleOutbound(ctxFor(update, telegram))).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    expect(await messagesOfConversation(conversationId)).toHaveLength(0);
  });

  it('④ Bot 非管理员 → 静默（零中继零落库；getChatMember 经缓存，design.md 校验 ④）', async () => {
    const customerId = await seedCustomer(BOT_NON_ADMIN.id, 9914);
    const conversationId = await seedOpenConversation(BOT_NON_ADMIN.id, customerId, BOT_NON_ADMIN.support_chat_id, 818);
    await seedAdmin(BOT_NON_ADMIN.id, ADMIN_ID);
    const { telegram, calls } = makeTelegram({
      getChatMember: () => ({ status: 'member', user: { id: BOT_NON_ADMIN.telegram_bot_id, is_bot: true, first_name: 'hodor' } }),
      copyMessage: () => ({ message_id: 9004 }), // 若被调用则测试失败（未编排断言语义之外的显式哨兵）
    });
    const update: TelegramUpdate = {
      update_id: 3004,
      message: {
        message_id: 3004,
        from: { id: ADMIN_ID, is_bot: false, first_name: 'Admin' },
        chat: { id: BOT_NON_ADMIN.support_chat_id, type: 'supergroup' },
        date: 1760000000,
        message_thread_id: 818,
        text: 'bot demoted',
      },
    };

    await expect(handleOutbound(ctxFor(update, telegram, BOT_NON_ADMIN))).resolves.toBeUndefined();

    expect(callsOf(calls, 'getChatMember')).toHaveLength(1); // 校验外呼仅此一次
    expect(callsOf(calls, 'copyMessage')).toHaveLength(0);
    expect(await messagesOfConversation(conversationId)).toHaveLength(0);
  });

  it('⑤ 正常出站：copy 参数（from=群消息/to=客户私聊，无 thread）+ 落库 9 字段 + 文本/媒体提取 + 缓存复用', async () => {
    const conversationId = await seedValidTopic(9901, 811);
    expect(getUpdateHandler('outbound')).toBe(handleOutbound); // 注册表挂载（S5）

    const first = makeTelegram(outboundOkStubs(9005));
    await handleOutbound(ctxFor(topicTextUpdate(3011, 3011, ADMIN_ID, 'reply to customer', 811), first.telegram));

    const copyCalls = callsOf(first.calls, 'copyMessage');
    expect(copyCalls).toHaveLength(1);
    // from = (支持群, 群内消息)，to = 客户 telegram_user_id（D1 事实源）；私聊无 message_thread_id
    expect(copyCalls[0]?.payload).toEqual({
      chat_id: 9901,
      from_chat_id: SUPPORT_CHAT_ID,
      message_id: 3011,
    });
    expect(callsOf(first.calls, 'getChatMember')).toHaveLength(1); // 首次 miss → 回填缓存

    const msgs = await messagesOfConversation(conversationId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      direction: 'outbound',
      source_chat_id: SUPPORT_CHAT_ID,
      source_message_id: 3011,
      target_chat_id: 9901,
      target_message_id: 9005,
      message_thread_id: 811,
      content_type: 'text',
      text_content: 'reply to customer',
      media_file_id: null,
    });

    // 第二条（媒体）：getChatMember 命中缓存不再外呼；caption/file_id 沿用 S4 提取规则
    const second = makeTelegram(outboundOkStubs(9006));
    await handleOutbound(ctxFor(topicPhotoUpdate(3012, 3012, ADMIN_ID, 'photo reply', 811), second.telegram));
    expect(callsOf(second.calls, 'getChatMember')).toHaveLength(0); // 缓存命中（docs/02 TTL≈5min）
    expect(callsOf(second.calls, 'copyMessage')).toHaveLength(1);
    const msgsAfter = await messagesOfConversation(conversationId);
    expect(msgsAfter).toHaveLength(2);
    expect(msgsAfter[1]).toMatchObject({
      direction: 'outbound',
      content_type: 'photo',
      text_content: 'photo reply',
      media_file_id: 'photo-big',
      target_message_id: 9006,
    });
  });

  it('⑥ 403 首次：flag 0→1 + Topic 一次性提示 + 照常落库（target_message_id 落 NULL）', async () => {
    const conversationId = await seedValidTopic(9902, 812);
    const { telegram, calls } = makeTelegram({
      ...outboundOkStubs(9007),
      copyMessage: blocked403Stub,
      sendMessage: () => ({ message_id: 9017 }), // 拉黑提示发送成功路径
    });

    await expect(handleOutbound(ctxFor(topicTextUpdate(3021, 3021, ADMIN_ID, 'still replying', 812), telegram))).resolves
      .toBeUndefined();

    expect((await customerRow(BOT_ID, 9902))?.bot_blocked_by_user).toBe(1); // 置位（docs/03）

    const notices = callsOf(calls, 'sendMessage');
    expect(notices).toHaveLength(1); // 仅首次跳变提示
    expect(notices[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 812,
      text: BOT_BLOCKED_NOTICE,
    });

    const msgs = await messagesOfConversation(conversationId);
    expect(msgs).toHaveLength(1); // 两种情况照常落库
    expect(msgs[0]).toEqual({
      direction: 'outbound',
      source_chat_id: SUPPORT_CHAT_ID,
      source_message_id: 3021,
      target_chat_id: 9902,
      target_message_id: null, // copy 未送达
      message_thread_id: 812,
      content_type: 'text',
      text_content: 'still replying',
      media_file_id: null,
    });
  });

  it('⑦ 403 置位期：不重复提示，仍照常尝试 copy + 落库（docs/03 非闸门语义）', async () => {
    const conversationId = await seedValidTopic(9903, 813, 1); // flag 已为 1
    const { telegram, calls } = makeTelegram({ ...outboundOkStubs(9008), copyMessage: blocked403Stub });

    await handleOutbound(ctxFor(topicTextUpdate(3022, 3022, ADMIN_ID, 'try again', 813), telegram));

    expect(callsOf(calls, 'copyMessage')).toHaveLength(1); // 置位期仍照常尝试（用户可能已回归）
    expect(callsOf(calls, 'sendMessage')).toHaveLength(0); // 无 0→1 跳变 → 不刷屏
    expect(await messagesOfConversation(conversationId)).toHaveLength(1);
  });

  it('⑧ 恢复闭环：用户再次入站 → flag 1→0 + Topic 恢复提示（S5 联调，docs/03）', async () => {
    const customerId = await seedCustomer(BOT_ID, 9904, 1);
    const conversationId = await seedOpenConversation(BOT_ID, customerId, SUPPORT_CHAT_ID, 814);
    const { telegram, calls } = makeTelegram({
      copyMessage: () => ({ message_id: 9009 }),
      sendMessage: () => ({ message_id: 9010 }),
    });

    await handleInbound(ctxFor(privateTextUpdate(3031, 9904, 'I am back'), telegram));

    expect((await customerRow(BOT_ID, 9904))?.bot_blocked_by_user).toBe(0); // 复位

    const notices = callsOf(calls, 'sendMessage');
    expect(notices).toHaveLength(1); // 老用户无 WELCOME，唯一 sendMessage 即恢复提示
    expect(notices[0]?.payload).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 814,
      text: BOT_UNBLOCKED_NOTICE,
    });
    expect(callsOf(calls, 'copyMessage')).toHaveLength(1); // 入站照常中继
    expect(await messagesOfConversation(conversationId)).toHaveLength(1);
  });

  it('⑨ 命令文本不中继：/ 前缀 → command，注册表 S6 前为空 no-op（零外呼零落库）', async () => {
    const conversationId = await seedValidTopic(9905, 815);
    const update = topicTextUpdate(3041, 3041, ADMIN_ID, '/ban 5', 815);
    expect(classifyUpdate(update, BOT.telegram_bot_id)).toBe('command');
    expect(getUpdateHandler('command')).not.toBe(handleOutbound);

    const { telegram, calls } = makeTelegram(outboundOkStubs(9011));
    const commandHandler = getUpdateHandler('command');
    await expect(commandHandler(ctxFor(update, telegram))).resolves.toBeUndefined();

    expect(calls).toHaveLength(0); // 命令绝不进入 copyMessage（docs/03）
    expect(await messagesOfConversation(conversationId)).toHaveLength(0);
  });

  it('⑩ 429（retry_after > 3s）→ retryable 抛出 → 状态机 5xx pending（Telegram 重投）', async () => {
    const conversationId = await seedValidTopic(9906, 816);
    const update = topicTextUpdate(3051, 3051, ADMIN_ID, 'rate limited', 816);
    const registration = await registerUpdate(db, BOT_ID, update);
    const { telegram, calls } = makeTelegram({
      getChatMember: adminMemberStub,
      copyMessage: () => ({
        status: 429,
        body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 5 } },
      }),
    });

    const result = await processUpdate(ctxFor(update, telegram), registration, handleOutbound, resolveMaxAttempts('8'));

    expect(result.httpStatus).toBe(500); // → Telegram 重投（docs/03 错误分类）
    expect(result.rowStatus).toBe('pending');
    const row = await inboxRow(3051);
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain('copyMessage failed (retryable)');
    expect(await messagesOfConversation(conversationId)).toHaveLength(0);
    expect(callsOf(calls, 'sendMessage')).toHaveLength(0);
  });
});
