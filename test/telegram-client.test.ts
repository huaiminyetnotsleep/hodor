import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemberCache, createTelegramClient } from '../src/telegram';
import type { TelegramChatMember } from '../src/telegram';

const BOT_TOKEN = '123456:TEST-TOKEN';
const CHAT = -100999;
const USER_CHAT = 555;
const copyMessageParams = { chatId: CHAT, fromChatId: USER_CHAT, messageId: 42 };

const adminMember: TelegramChatMember = {
  status: 'administrator',
  user: { id: 42, is_bot: true, first_name: 'hodor' },
};

const memberOf = (id: number): TelegramChatMember => ({
  status: 'member',
  user: { id, is_bot: false, first_name: `user-${id}` },
});

// ── fetch 打桩（docs/10：全部预编排响应，不发起真实网络）────────────────────

type FetchInit = Parameters<typeof fetch>[1];
type StagedResponse = { status: number; body: unknown } | Response | Error;

interface FetchCall {
  url: string;
  init?: FetchInit;
}

function stagedFetch(responses: StagedResponse[]) {
  const queue = [...responses];
  const calls: FetchCall[] = [];

  const fetchImpl = vi.fn((...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error('stagedFetch: 出现未编排的请求'));
    if (next instanceof Error) return Promise.reject(next);
    if (next instanceof Response) return Promise.resolve(next);
    return Promise.resolve(
      new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } }),
    );
  });

  const callAt = (index: number): FetchCall => {
    const call = calls[index];
    if (call === undefined) throw new Error(`stagedFetch: 第 ${index} 次请求不存在`);
    return call;
  };

  return { fetchImpl, callAt };
}

function makeClient(stages: StagedResponse[]) {
  const { fetchImpl, callAt } = stagedFetch(stages);
  return { client: createTelegramClient({ botToken: BOT_TOKEN, fetchImpl }), fetchImpl, callAt };
}

/**
 * 冲刷事件循环若干转：让「fetch 桩 → Response.text() → 分类 → 排定 retry 等待」这条链走完。
 * 全部以 0ms 推进，不会误触 retry_after ≥ 1s 的等待定时器。
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  vi.useRealTimers();
});

// ── 错误三态分类（design.md 决策表，docs/03）────────────────────────────────

describe('错误分类（design.md 决策表）', () => {
  it('HTTP 200 且 ok:true → TelegramOk，透传 result', async () => {
    const { client, fetchImpl } = makeClient([{ status: 200, body: { ok: true, result: { message_id: 7 } } }]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: true, result: { message_id: 7 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 200 且 ok:false（Telegram 业务错）→ permanent，errorMessage = description', async () => {
    const { client, fetchImpl } = makeClient([
      { status: 200, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } },
    ]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: false, kind: 'permanent', errorMessage: 'Bad Request: chat not found' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 429 retry_after=2（≤3s）→ 等待后原地重试一次，成功 → Ok', async () => {
    vi.useFakeTimers();
    const { client, fetchImpl } = makeClient([
      { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 2 } } },
      { status: 200, body: { ok: true, result: { message_id: 7 } } },
    ]);

    const pending = client.copyMessage(copyMessageParams);
    await flushMicrotasks();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 等待 retry_after 期间不重试（docs/03：等待后原地重试）

    await vi.advanceTimersByTimeAsync(2_000); // 推过 2s 等待窗口
    expect(await pending).toEqual({ ok: true, result: { message_id: 7 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 计入本次处理的原地重试
  });

  it('HTTP 429 retry_after=1（≤3s）→ 重试仍 429 → retryable 带新 retryAfterSeconds，不再二次重试', async () => {
    vi.useFakeTimers();
    const { client, fetchImpl } = makeClient([
      { status: 429, body: { ok: false, parameters: { retry_after: 1 } } },
      { status: 429, body: { ok: false, parameters: { retry_after: 5 } } },
    ]);

    const pending = client.copyMessage(copyMessageParams);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000); // 第一次等待 1s 后重试

    expect(await pending).toEqual({ ok: false, kind: 'retryable', retryAfterSeconds: 5 });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 只重试一次，防放大（design.md）
  });

  it('HTTP 429 retry_after=5（>3s）→ 不原地重试，直接 retryable 上抛', async () => {
    const { client, fetchImpl } = makeClient([
      { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 5 } } },
    ]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: false, kind: 'retryable', retryAfterSeconds: 5, errorMessage: 'Too Many Requests' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 429 无 parameters.retry_after → 缺省按 >3s 处理：不重试、无 retryAfterSeconds', async () => {
    const { client, fetchImpl } = makeClient([{ status: 429, body: { ok: false, description: 'Too Many Requests' } }]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: false, kind: 'retryable', errorMessage: 'Too Many Requests' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 403 → permanent（调用方据此走 bot_blocked_by_user，docs/03）', async () => {
    const { client, fetchImpl } = makeClient([
      { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } },
    ]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: false, kind: 'permanent', errorMessage: 'Forbidden: bot was blocked by the user' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 400 → permanent（毒丸不重试），保留 errorMessage 供 last_error', async () => {
    const { client, fetchImpl } = makeClient([
      { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message to copy not found' } },
    ]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: false, kind: 'permanent', errorMessage: 'Bad Request: message to copy not found' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 500（响应体非 JSON）→ retryable', async () => {
    const { client, fetchImpl } = makeClient([new Response('Internal Server Error', { status: 500 })]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: false, kind: 'retryable', errorMessage: 'HTTP 500' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetch 拒绝（网络异常/断网）→ retryable', async () => {
    const { client, fetchImpl } = makeClient([new Error('network down')]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: false, kind: 'retryable', errorMessage: 'network down' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 200 但响应体非 JSON（如网关错误页）→ retryable', async () => {
    const { client, fetchImpl } = makeClient([new Response('<html>oops</html>', { status: 200 })]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: false, kind: 'retryable', errorMessage: 'non-JSON response body' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('其他 4xx（404）→ permanent（缺省保守：不可重试）', async () => {
    const { client, fetchImpl } = makeClient([
      { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } },
    ]);

    const result = await client.copyMessage(copyMessageParams);

    expect(result).toEqual({ ok: false, kind: 'permanent', errorMessage: 'Not Found' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ── 参数拼装（URL / method / body 字段显式映射）──────────────────────────────

describe('参数拼装（URL / method / body）', () => {
  it('copyMessage：URL 含 botToken 与方法名，POST JSON body 字段 chat_id/from_chat_id/message_id', async () => {
    const { client, callAt } = makeClient([{ status: 200, body: { ok: true, result: { message_id: 7 } } }]);

    await client.copyMessage({ chatId: CHAT, fromChatId: USER_CHAT, messageId: 42 });

    const call = callAt(0);
    expect(call.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`);
    expect(call.init?.method).toBe('POST');
    expect(call.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(call.init?.body))).toEqual({ chat_id: CHAT, from_chat_id: USER_CHAT, message_id: 42 });
  });

  it('createForumTopic：body 字段 chat_id/name/icon_color；未提供的可选字段不出现', async () => {
    const { client, callAt } = makeClient([
      { status: 200, body: { ok: true, result: { message_thread_id: 11 } } },
      { status: 200, body: { ok: true, result: { message_thread_id: 12 } } },
    ]);

    await client.createForumTopic({ chatId: CHAT, name: '👤 Alice (987654321) · #1001', iconColor: '7666ac' });
    expect(callAt(0).url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`);
    expect(JSON.parse(String(callAt(0).init?.body))).toEqual({
      chat_id: CHAT,
      name: '👤 Alice (987654321) · #1001',
      icon_color: '7666ac',
    });

    await client.createForumTopic({ chatId: CHAT, name: '👤 Bob (987654322) · #1002' });
    expect(JSON.parse(String(callAt(1).init?.body))).toEqual({ chat_id: CHAT, name: '👤 Bob (987654322) · #1002' });
  });

  it('setWebhook：secret_token/allowed_updates/drop_pending_updates 映射 snake_case', async () => {
    const { client, callAt } = makeClient([{ status: 200, body: { ok: true, result: true } }]);

    await client.setWebhook({
      url: 'https://hodor.example.com/telegram/webhook/k-test',
      secretToken: 'sec-1',
      allowedUpdates: ['message'], // docs/03：显式 allowed_updates = ["message"]
      dropPendingUpdates: false,
    });

    expect(JSON.parse(String(callAt(0).init?.body))).toEqual({
      url: 'https://hodor.example.com/telegram/webhook/k-test',
      secret_token: 'sec-1',
      allowed_updates: ['message'],
      drop_pending_updates: false, // 显式 false 也保留（只剔除 undefined）
    });
  });

  it('getChatMember：body 字段 chat_id/user_id', async () => {
    const { client, callAt } = makeClient([{ status: 200, body: { ok: true, result: adminMember } }]);

    await client.getChatMember({ chatId: CHAT, userId: 42 });

    expect(JSON.parse(String(callAt(0).init?.body))).toEqual({ chat_id: CHAT, user_id: 42 });
  });
});

// ── getChatMember 成员缓存（docs/02 TTL≈5min；design.md LRU/容量 500）────────

describe('getChatMember 成员缓存', () => {
  /** S5 的组合方式：先查缓存，miss 时 getChatMember 并回填（client 与 cache 解耦，由调用方组合） */
  function makeCachedMemberGetter(stages: StagedResponse[]) {
    const { client, fetchImpl } = makeClient(stages);
    const cache = createMemberCache();
    const getMember = async (chatId: number, userId: number): Promise<TelegramChatMember> => {
      const cached = cache.get(chatId, userId);
      if (cached !== undefined) return cached;
      const result = await client.getChatMember({ chatId, userId });
      if (!result.ok) throw new Error(`unexpected TelegramResult: ${JSON.stringify(result)}`);
      cache.set(chatId, userId, result.result);
      return result.result;
    };
    return { getMember, fetchImpl };
  }

  it('缓存命中不重复请求；TTL 过期后重新请求', async () => {
    vi.useFakeTimers();
    const { getMember, fetchImpl } = makeCachedMemberGetter([
      { status: 200, body: { ok: true, result: adminMember } },
      { status: 200, body: { ok: true, result: adminMember } },
    ]);

    const first = await getMember(CHAT, 42);
    const second = await getMember(CHAT, 42); // TTL 内命中
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1); // 过 TTL（5min）
    const third = await getMember(CHAT, 42);
    expect(third).toEqual(adminMember);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 过期后重新请求
  });

  it('不同成员互不命中（key = chatId:userId）', async () => {
    const { getMember, fetchImpl } = makeCachedMemberGetter([
      { status: 200, body: { ok: true, result: adminMember } },
      { status: 200, body: { ok: true, result: adminMember } },
    ]);

    await getMember(CHAT, 42);
    await getMember(CHAT, 43);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('LRU：容量超限淘汰最久未用', () => {
    const cache = createMemberCache(60_000, 2);

    cache.set(CHAT, 10, memberOf(10));
    cache.set(CHAT, 11, memberOf(11));
    cache.get(CHAT, 10); // 触碰 10 → 最久未用变为 11
    cache.set(CHAT, 12, memberOf(12)); // 淘汰 11

    expect(cache.get(CHAT, 11)).toBeUndefined();
    expect(cache.get(CHAT, 10)).toEqual(memberOf(10));
    expect(cache.get(CHAT, 12)).toEqual(memberOf(12));
  });

  it('默认容量 500：第 501 条淘汰最旧条目', () => {
    const cache = createMemberCache();

    for (let userId = 1; userId <= 501; userId++) {
      cache.set(CHAT, userId, memberOf(userId));
    }

    expect(cache.get(CHAT, 1)).toBeUndefined();
    expect(cache.get(CHAT, 501)).toBeDefined();
  });
});
