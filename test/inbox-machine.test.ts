import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { getUpdateHandler, setUpdateHandler, type UpdateContext, type UpdateHandler } from '../src/domain';
import { resolveMaxAttempts } from '../src/inbox';
import { handleTelegramWebhook } from '../src/webhook';
import type { TelegramMessageId, TelegramResult, TelegramUpdate } from '../src/telegram';

// docs/10「幂等状态机」7 条 + 同 payload 重放 + MAX_ATTEMPTS 解析。
// 直接调用 handleTelegramWebhook 并经注册表注入桩处理器（docs/10：状态机可独立验证）；
// 鉴权语义另见 webhook-auth.test.ts。本文件隔离存储自迁移 + 种子唯一 bots 行（id=1）。

const db = env.DB;
const BOT_ID = 1;
const SECRET = 'unit-test-machine-secret';
const WEBHOOK_URL = 'https://example.com/telegram/webhook/k-machine-test-bot';
/** 显式固定 MAX_ATTEMPTS，不依赖 .dev.vars 是否被测试运行时加载 */
const webhookEnv = { ...env, MAX_ATTEMPTS: '8' };

/** 各桩的执行记录（每次调用 push update_id） */
let executed: number[] = [];

/** S4 语义的处理器内标记：blocked / 毒丸由处理器自行置 processed 后正常返回（docs/03 错误分类） */
async function markProcessedInHandler(ctx: UpdateContext): Promise<void> {
  await ctx.db
    .prepare(
      "UPDATE inbox_updates SET status = 'processed', processed_at = ? WHERE bot_id = ? AND telegram_update_id = ? AND status = 'pending'",
    )
    .bind(new Date().toISOString(), ctx.bot.id, ctx.update.update_id)
    .run();
}

const recordingHandler: UpdateHandler = async (ctx) => {
  executed.push(ctx.update.update_id);
};

const throwingHandler: UpdateHandler = async () => {
  throw new Error('stub: retryable failure');
};

/** blocked 拒绝桩：拒绝服务不是故障——标记 processed，不抛错（docs/03） */
const blockedMarkingHandler: UpdateHandler = async (ctx) => {
  executed.push(ctx.update.update_id);
  await markProcessedInHandler(ctx);
};

/** 毒丸桩：桩层模拟 telegram 客户端返回 permanent（400）——处理器捕获后标记 processed、不抛错 */
const poisonPillHandler: UpdateHandler = async (ctx) => {
  executed.push(ctx.update.update_id);
  const copyResult: TelegramResult<TelegramMessageId> = {
    ok: false,
    kind: 'permanent',
    errorMessage: 'Bad Request: message to copy not found',
  };
  if (!copyResult.ok && copyResult.kind === 'permanent') {
    await markProcessedInHandler(ctx);
    return;
  }
  throw new Error('stub: retryable branch is unreachable in this scenario');
};

const defaultInbound = getUpdateHandler('inbound');
const defaultCommand = getUpdateHandler('command');

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const secretHash = await sha256Hex(SECRET);
  await db
    .prepare(
      "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, created_at, updated_at) VALUES (4300, 'k-machine-test-bot', ?, -100999, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind(secretHash)
    .run();
});

afterEach(() => {
  executed = [];
  setUpdateHandler('inbound', defaultInbound);
  setUpdateHandler('command', defaultCommand);
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function privateUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 777000 + updateId, is_bot: false, first_name: 'User' },
      chat: { id: 777000 + updateId, type: 'private' },
      date: 1760000000,
      text: 'hello hodor',
    },
  };
}

function requestFor(update: TelegramUpdate): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify(update),
  });
}

async function callWebhook(updateId: number): Promise<Response> {
  return handleTelegramWebhook(requestFor(privateUpdate(updateId)), webhookEnv);
}

interface RowView {
  status: string;
  attempts: number;
  last_error: string | null;
  processed_at: string | null;
}

async function rowOf(updateId: number): Promise<RowView | null> {
  return db
    .prepare('SELECT status, attempts, last_error, processed_at FROM inbox_updates WHERE bot_id = ? AND telegram_update_id = ?')
    .bind(BOT_ID, updateId)
    .first<RowView>();
}

/** 直接种子 pending 行（模拟「登记后处理失败/崩溃」的存量状态） */
async function seedPendingRow(updateId: number, attempts: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO inbox_updates (bot_id, telegram_update_id, payload_json, status, attempts, received_at) VALUES (?, ?, ?, 'pending', ?, '2026-01-01T00:00:00Z')",
    )
    .bind(BOT_ID, updateId, JSON.stringify(privateUpdate(updateId)), attempts)
    .run();
}

describe('幂等状态机（docs/10 七条，docs/03 状态图）', () => {
  it('① 新 Update：登记 → 处理器执行一次 → processed + processed_at，200', async () => {
    setUpdateHandler('inbound', recordingHandler);

    const res = await callWebhook(1001);

    expect(res.status).toBe(200);
    const row = await rowOf(1001);
    expect(row?.status).toBe('processed');
    expect(row?.attempts).toBe(0);
    expect(row?.processed_at).not.toBeNull();
    expect(executed).toEqual([1001]);
  });

  it('② 同 payload 重放两次：两次均 200，处理器只执行一次（重复 processed 跳过）', async () => {
    setUpdateHandler('inbound', recordingHandler);

    const first = await callWebhook(2001);
    const second = await callWebhook(2001);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(executed).toEqual([2001]);
    expect((await rowOf(2001))?.attempts).toBe(0);
  });

  it('③ 处理失败 → 5xx 且 attempts 递增、保持 pending（last_error 留痕）', async () => {
    setUpdateHandler('inbound', throwingHandler);

    const res = await callWebhook(3001);

    expect(res.status).toBe(500);
    const row = await rowOf(3001);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe('stub: retryable failure');
    expect(row?.processed_at).toBeNull();
  });

  it('③b 重试闭环：失败 5xx 后 Telegram 重投，未超限重新执行并成功 → processed（attempts 保留 1）', async () => {
    setUpdateHandler('inbound', throwingHandler);
    expect((await callWebhook(3002)).status).toBe(500);

    setUpdateHandler('inbound', recordingHandler);
    const res = await callWebhook(3002);

    expect(res.status).toBe(200);
    const row = await rowOf(3002);
    expect(row?.status).toBe('processed');
    expect(row?.attempts).toBe(1);
    expect(executed).toEqual([3002]);
  });

  it('③c 种子 pending 行（attempts=1）重投：重新执行 → processed（不重置 attempts）', async () => {
    setUpdateHandler('inbound', recordingHandler);
    await seedPendingRow(3003, 1);

    const res = await callWebhook(3003);

    expect(res.status).toBe(200);
    const row = await rowOf(3003);
    expect(row?.status).toBe('processed');
    expect(row?.attempts).toBe(1);
    expect(executed).toEqual([3003]);
  });

  it('④ 超限：pending 且 attempts ≥ MAX_ATTEMPTS → 置 failed 返回 200，不执行处理器（手工 DLQ）', async () => {
    setUpdateHandler('inbound', recordingHandler);
    await seedPendingRow(4001, 8);

    const res = await callWebhook(4001);

    expect(res.status).toBe(200);
    const row = await rowOf(4001);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(8);
    expect(executed).toEqual([]);
  });

  it('④b 失败后达到上限：attempts+1 ≥ MAX_ATTEMPTS → failed + 200 停止重投（docs/03 状态图末支）', async () => {
    setUpdateHandler('inbound', throwingHandler);
    await seedPendingRow(4002, 7); // 本次为第 8 次执行

    const res = await callWebhook(4002);

    expect(res.status).toBe(200);
    const row = await rowOf(4002);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(8);
    expect(row?.last_error).toBe('stub: retryable failure');
  });

  it('⑤ blocked 拒绝：处理器内标记 processed → 200，重投不再执行（拒绝服务不是故障，docs/03）', async () => {
    setUpdateHandler('inbound', blockedMarkingHandler);

    const res = await callWebhook(5001);

    expect(res.status).toBe(200);
    const row = await rowOf(5001);
    expect(row?.status).toBe('processed');
    expect(row?.attempts).toBe(0);

    const redelivered = await callWebhook(5001);
    expect(redelivered.status).toBe(200);
    expect(executed).toEqual([5001]);
  });

  it('⑥ 400 毒丸：处理器捕获 permanent 标记 processed、不抛错 → 200 不进重试（桩层模拟）', async () => {
    setUpdateHandler('inbound', poisonPillHandler);

    const res = await callWebhook(6001);

    expect(res.status).toBe(200);
    const row = await rowOf(6001);
    expect(row?.status).toBe('processed');
    expect(row?.attempts).toBe(0);
    expect(row?.last_error).toBeNull();
    expect(executed).toEqual([6001]);
  });

  it('⑦ 群 Topic /命令 → command 路径：命令处理器执行（注入桩验证槽位接线）→ 200 processed', async () => {
    const commandExecuted: number[] = [];
    setUpdateHandler('command', async (ctx) => {
      commandExecuted.push(ctx.update.update_id);
    });
    const update: TelegramUpdate = {
      update_id: 7001,
      message: {
        message_id: 7001,
        from: { id: 900, is_bot: false, first_name: 'Admin' },
        chat: { id: -100999, type: 'supergroup' },
        date: 1760000000,
        message_thread_id: 7,
        text: '/ban 5',
      },
    };

    const res = await handleTelegramWebhook(requestFor(update), webhookEnv);

    expect(res.status).toBe(200);
    expect((await rowOf(7001))?.status).toBe('processed');
    expect(commandExecuted).toEqual([7001]);
  });

  it('⑧ edited_message → ignore：不触碰处理器，登记后标记 processed（docs/03 忽略策略）', async () => {
    setUpdateHandler('inbound', recordingHandler);
    const update = {
      update_id: 8001,
      edited_message: {
        message_id: 8001,
        from: { id: 777000, is_bot: false, first_name: 'User' },
        chat: { id: 777000, type: 'private' },
        date: 1760000000,
        text: 'edited',
      },
    } as unknown as TelegramUpdate;

    const res = await handleTelegramWebhook(requestFor(update), webhookEnv);

    expect(res.status).toBe(200);
    const row = await rowOf(8001);
    expect(row?.status).toBe('processed');
    expect(executed).toEqual([]);
  });
});

describe('resolveMaxAttempts（env.MAX_ATTEMPTS 解析：非法/缺失回退 8，spec/backend/env-config）', () => {
  it('undefined（env 缺失）→ 8', () => {
    expect(resolveMaxAttempts(undefined)).toBe(8);
  });

  it("合法值生效：'8' → 8、'12' → 12", () => {
    expect(resolveMaxAttempts('8')).toBe(8);
    expect(resolveMaxAttempts('12')).toBe(12);
  });

  it("非正整数回退 8：'0'、'-2'、'2.5'、''", () => {
    expect(resolveMaxAttempts('0')).toBe(8);
    expect(resolveMaxAttempts('-2')).toBe(8);
    expect(resolveMaxAttempts('2.5')).toBe(8);
    expect(resolveMaxAttempts('')).toBe(8);
  });

  it("非数字回退 8：'abc'", () => {
    expect(resolveMaxAttempts('abc')).toBe(8);
  });
});
