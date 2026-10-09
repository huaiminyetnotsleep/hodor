/**
 * GET /verify + POST /api/verify/turnstile 路由用例（Turnstile 任务阶段 5）：
 *
 * - GET：安全页面头（no-store / nosniff / CSP nonce / 无 XFO）、nonce 格式
 *   校验、页面不泄漏 Secret；
 * - POST：design §4 错误码矩阵全分支（400 / 401 / 403 / 404 / 409 / 410 /
 *   413 / 422 / 429 / 503）+ 唯一 200 获胜路径；Siteverify 先本地预检后
 *   调用、成功也核对上下文；15 秒认领窗口（429 不调上游）；最终 CAS 唯一
 *   授权；成功通知 warn 策略（通知失败不影响 200）；系统消息不入账本；
 *   并发双提交恰一胜。
 *
 * initData 用测试内独立 WebCrypto 签名助手（与被测模块零共享实现）实时
 * 签发（auth_date 贴真实时钟）；算法正确性另由 test/verification.test.ts
 * 的独立固定向量守卫。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VERIFY_PASSED_TEXT } from "../src/copy";
import { handleVerifyPage, handleVerifySubmit } from "../src/routes/verify";
import { upsertBot } from "../src/store/bots";
import { applyVerificationConfigChange, getVerificationSettings } from "../src/store/settings";
import { sha256Hex } from "../src/verification/request";

const BOT_ID = 42;
const USER_ID = 7701;
const OTHER_USER_ID = 7702;
const NONCE = "c".repeat(64);
const PAGE_ORIGIN = "https://example.com";
const SITE_KEY = "0x4AAAAAAA_site";
const SECRET_KEY = "0x4AAAAAAA_secret";

/** handleVerify* 实际读取的最小 env（TURNSTILE 凭据齐全；公开值可进断言） */
function envWith(overrides: Record<string, string | undefined> = {}): Cloudflare.Env {
  return {
    HODOR_DB: env.HODOR_DB,
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    ADMIN_SECRET: "test-admin-secret",
    SUPPORT_CHAT_ID: "-1001234567890",
    ADMIN_IDS: "111111111,222222222",
    TURNSTILE_SITE_KEY: SITE_KEY,
    TURNSTILE_SECRET_KEY: SECRET_KEY,
    ...overrides,
  } as unknown as Cloudflare.Env;
}

/* ------------- 出站桩：api.telegram.org + siteverify 同桩分派 ------------- */

interface OutboundStub {
  siteverifyCalls: Record<string, unknown>[];
  telegramCalls: { method: string; body: unknown }[];
  setTelegram(method: string, response: { status?: number; json?: unknown }): void;
  setSiteverify(
    respond?: (callIndex: number, body: Record<string, unknown>) => { status?: number; json?: unknown } | { throwError: true },
  ): void;
  restore(): void;
}

function stubOutbound(): OutboundStub {
  const originalFetch = globalThis.fetch;
  const stub: OutboundStub = {
    siteverifyCalls: [],
    telegramCalls: [],
    setTelegram(method, response) {
      telegramResponders.set(method, () => response);
    },
    setSiteverify(respond) {
      siteverifyResponder = respond ?? null;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
  const telegramResponders = new Map<string, () => { status?: number; json?: unknown }>();
  let siteverifyResponder: ((callIndex: number, body: Record<string, unknown>) => { status?: number; json?: unknown } | { throwError: true }) | null = null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      stub.siteverifyCalls.push(body);
      const respond = siteverifyResponder?.(stub.siteverifyCalls.length - 1, body);
      if (respond && "throwError" in respond) throw new Error("simulated siteverify failure");
      return new Response(
        JSON.stringify(
          respond?.json ?? { success: true, hostname: "example.com", action: "hodor_verify", cdata: NONCE },
        ),
        { status: respond?.status ?? 200, headers: { "content-type": "application/json" } },
      );
    }
    const match = url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/([A-Za-z]+)$/);
    if (!match) throw new Error(`unexpected outbound fetch: ${url}`);
    const [, method] = match;
    stub.telegramCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const responder = telegramResponders.get(method);
    if (!responder) throw new Error(`no responder registered for ${method}`);
    const response = responder();
    return new Response(JSON.stringify(response.json ?? { ok: true, result: true }), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return stub;
}

/* ------------------------- initData 独立签名助手 ------------------------- */

async function hmacSign(keyHexSource: ArrayBuffer | Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyHexSource instanceof Uint8Array ? keyHexSource : new Uint8Array(keyHexSource),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 按官方算法（测试侧独立实现）为指定用户签发新鲜的 initData */
async function buildInitData(
  userId: number,
  botToken = "test-bot-token",
  authDate = Math.floor(Date.now() / 1000) - 5,
): Promise<string> {
  const fields: Record<string, string> = {
    auth_date: String(authDate),
    query_id: "AAF9tE0aAAAAAHEt6i16OQx9",
    user: JSON.stringify({ id: userId, first_name: "Web", username: `web_${userId}` }),
  };
  const secret = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    new TextEncoder().encode(botToken),
  );
  const check = Object.entries(fields)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const hash = await hmacSign(secret, check);
  return `${Object.entries(fields)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&")}&hash=${hash}`;
}

/* ------------------------------ 播种助手 ------------------------------ */

async function seedTurnstileReady(userId: number = USER_ID, nonce: string = NONCE): Promise<void> {
  const settings = await getVerificationSettings(env.HODOR_DB);
  const hash = await sha256Hex(nonce);
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  await env.HODOR_DB.prepare(
    `INSERT INTO users (bot_id, user_id, first_name, first_seen_at, last_seen_at, verify_msg_id,
       verify_request_hash, verify_request_expires_at, verify_request_generation)
     VALUES (?, ?, 'Web', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 4600, ?, ?, ?)
     ON CONFLICT (bot_id, user_id) DO UPDATE SET
       is_verified = 0, verified_at = NULL, is_banned = 0,
       verify_answer = NULL, verify_msg_id = 4600, verify_submit_not_before = NULL,
       verify_request_hash = excluded.verify_request_hash,
       verify_request_expires_at = excluded.verify_request_expires_at,
       verify_request_generation = excluded.verify_request_generation`,
  )
    .bind(BOT_ID, userId, hash, expiresAt, settings.verifyGeneration)
    .run();
}

function submitRequest(body: unknown, overrides: Record<string, string> = {}): Request {
  return new Request(`${PAGE_ORIGIN}/api/verify/turnstile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: PAGE_ORIGIN,
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

const submitBody = async (userId: number = USER_ID, requestId: string = NONCE) => ({
  requestId,
  initData: await buildInitData(userId),
  turnstileToken: "tok_" + "x".repeat(40),
});

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
  await applyVerificationConfigChange(env.HODOR_DB, { mode: "turnstile", enabled: true });
});

let stub: OutboundStub;
beforeEach(() => {
  stub = stubOutbound();
  stub.setTelegram("editMessageText", { json: { ok: true, result: { message_id: 1 } } });
});
afterEach(() => {
  stub.restore();
});

describe("GET /verify 页面", () => {
  it("合法 nonce → 200 text/html：no-store / nosniff / CSP（nonce）/ 无 XFO；页面含公开 Site Key 与 nonce 参数，绝无 Secret", async () => {
    const res = handleVerifyPage(new Request(`${PAGE_ORIGIN}/verify?r=${NONCE}`), envWith());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("challenges.cloudflare.com");
    expect(csp).toContain("telegram.org");
    expect(csp).not.toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain(SITE_KEY);
    expect(html).toContain(NONCE); // requestId 注入脚本
    expect(html).not.toContain(SECRET_KEY);
    expect(html).not.toContain("test-bot-token");
  });

  it("非法 nonce（缺参 / 非十六进制 / 错长度）→ 400", async () => {
    for (const r of [undefined, "短", "A".repeat(64), `${"g".repeat(63)}a`, `${NONCE}0`]) {
      const url = r === undefined ? `${PAGE_ORIGIN}/verify` : `${PAGE_ORIGIN}/verify?r=${r}`;
      const res = handleVerifyPage(new Request(url), envWith());
      expect(res.status, `r=${String(r)}`).toBe(400);
    }
  });

  it("GET 不能消费请求：页面访问后提交照常可用", async () => {
    await seedTurnstileReady();
    handleVerifyPage(new Request(`${PAGE_ORIGIN}/verify?r=${NONCE}`), envWith());
    const res = await handleVerifySubmit(submitRequest(await submitBody()), envWith());
    expect(res.status).toBe(200);
  });
});

describe("POST /api/verify/turnstile：200 获胜路径", () => {
  it("全链成功：Siteverify 恰一次（请求体带 secret/response/key）→ 200 {status:verified} + DB 验证态 + 全部 pending 清空 + 通过通知（题面编辑）", async () => {
    await seedTurnstileReady();
    const body = await submitBody();
    const res = await handleVerifySubmit(submitRequest(body), envWith());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "verified" });

    expect(stub.siteverifyCalls).toHaveLength(1);
    const svBody = stub.siteverifyCalls[0];
    expect(svBody.secret).toBe(SECRET_KEY);
    expect(svBody.response).toBe(body.turnstileToken);
    expect(typeof svBody.idempotency_key).toBe("string");

    const row = await env.HODOR_DB.prepare(
      `SELECT is_verified, verified_at, verify_request_hash, verify_request_expires_at,
         verify_request_generation, verify_submit_not_before, verify_msg_id
       FROM users WHERE bot_id = ? AND user_id = ?`,
    ).bind(BOT_ID, USER_ID).first<Record<string, unknown>>();
    expect(row!.is_verified).toBe(1);
    expect(row!.verified_at).not.toBeNull();
    expect(row!.verify_request_hash).toBeNull();
    expect(row!.verify_submit_not_before).toBeNull();

    // 成功通知（web 策略）：题面消息编辑为通过文案
    const edit = stub.telegramCalls.find((call) => call.method === "editMessageText");
    expect(edit).toBeDefined();
    expect((edit!.body as Record<string, unknown>).text).toBe(VERIFY_PASSED_TEXT);
    expect((edit!.body as Record<string, unknown>).chat_id).toBe(USER_ID);

    // 系统验证消息不入 messages 账本
    const ledger = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, USER_ID).first<{ n: number }>();
    expect(ledger!.n).toBe(0);
  });

  it("通知面 Telegram 失败（题面 edit 500）→ 仍 200（web 策略 warn，不回滚验证）", async () => {
    await seedTurnstileReady();
    stub.setTelegram("editMessageText", { status: 500, json: { ok: false, description: "boom" } });
    const res = await handleVerifySubmit(submitRequest(await submitBody()), envWith());
    expect(res.status).toBe(200);
    const row = await env.HODOR_DB.prepare(
      "SELECT is_verified FROM users WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, USER_ID).first<{ is_verified: number }>();
    expect(row!.is_verified).toBe(1);
  });

  it("并发双提交（同请求同 token）→ 恰一胜：一个 200，另一个 409/429；is_verified 恰一次转换", async () => {
    await seedTurnstileReady();
    const body = await submitBody();
    const [a, b] = await Promise.all([
      handleVerifySubmit(submitRequest(body), envWith()),
      handleVerifySubmit(submitRequest(body), envWith()),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1] === 409 || statuses[1] === 429).toBe(true);
    const row = await env.HODOR_DB.prepare(
      "SELECT is_verified, verified_at FROM users WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, USER_ID).first<{ is_verified: number; verified_at: string | null }>();
    expect(row!.is_verified).toBe(1);
  });
});

describe("POST /api/verify/turnstile：错误码矩阵", () => {
  /** 断言失败响应的通用形状（稳定 code + 无任何机密值泄漏） */
  async function expectError(res: Response, status: number, code: string): Promise<void> {
    expect(res.status).toBe(status);
    const json = (await res.json()) as { status: string; code: string };
    expect(json.status).toBe("error");
    expect(json.code).toBe(code);
    const text = JSON.stringify(json);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("test-bot-token");
  }

  it("400：Content-Type 非 JSON / body 非 JSON / 形状非法（缺键、nonce 格式错、token 超长、initData 超长）", async () => {
    await seedTurnstileReady();
    const wrongType = new Request(`${PAGE_ORIGIN}/api/verify/turnstile`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: PAGE_ORIGIN },
      body: "x",
    });
    await expectError(await handleVerifySubmit(wrongType, envWith()), 400, "invalid_request");

    const nonJson = new Request(`${PAGE_ORIGIN}/api/verify/turnstile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: PAGE_ORIGIN },
      body: "not json",
    });
    await expectError(await handleVerifySubmit(nonJson, envWith()), 400, "invalid_request");

    const initData = await buildInitData(USER_ID);
    for (const body of [
      { initData, turnstileToken: "tok" }, // 缺 requestId
      { requestId: "short", initData, turnstileToken: "tok" }, // nonce 格式错
      { requestId: NONCE, initData, turnstileToken: "t".repeat(2049) }, // token 超长
      { requestId: NONCE, initData: "", turnstileToken: "tok" }, // initData 空
      { requestId: NONCE, turnstileToken: "tok" }, // 缺 initData
    ]) {
      await expectError(await handleVerifySubmit(submitRequest(body), envWith()), 400, "invalid_request");
    }
    // 400 路径零上游调用、零状态变化
    expect(stub.siteverifyCalls).toHaveLength(0);
    expect((await seedState())!.verify_request_hash).not.toBeNull();
  });

  it("413：超过 16 KiB（读 body 计量，不依赖 Content-Length 头）", async () => {
    await seedTurnstileReady();
    const big = {
      requestId: NONCE,
      initData: await buildInitData(USER_ID),
      turnstileToken: "t".repeat(17 * 1024),
    };
    const res = await handleVerifySubmit(submitRequest(big), envWith());
    await expectError(res, 413, "payload_too_large");
    expect(stub.siteverifyCalls).toHaveLength(0);
  });

  it("401：initData 签名错误（错误 Bot Token 签发）与身份过期（auth_date 超 300 秒）", async () => {
    await seedTurnstileReady();
    const wrongToken = await buildInitData(USER_ID, "other-bot-token");
    await expectError(
      await handleVerifySubmit(submitRequest({ requestId: NONCE, initData: wrongToken, turnstileToken: "tok" }), envWith()),
      401,
      "unauthorized",
    );
    const expired = await buildInitData(USER_ID, "test-bot-token", Math.floor(Date.now() / 1000) - 400);
    await expectError(
      await handleVerifySubmit(submitRequest({ requestId: NONCE, initData: expired, turnstileToken: "tok" }), envWith()),
      401,
      "unauthorized",
    );
    expect(stub.siteverifyCalls).toHaveLength(0); // 身份未过不上游
  });

  it("403：用户不符（他人身份持有人链接）/ 来源不符（Origin 交叉）/ 已封禁", async () => {
    // 链接属于 USER_ID；OTHER 有自己的不同请求——他人身份提交他人链接 → 反查 403
    await seedTurnstileReady(USER_ID);
    await seedTurnstileReady(OTHER_USER_ID, "d".repeat(64));
    const other = await buildInitData(OTHER_USER_ID);
    await expectError(
      await handleVerifySubmit(submitRequest({ requestId: NONCE, initData: other, turnstileToken: "tok" }), envWith()),
      403,
      "forbidden",
    );

    // Origin 与页面 origin 不符
    await expectError(
      await handleVerifySubmit(
        submitRequest(await submitBody(), { origin: "https://evil.example.com" }),
        envWith(),
      ),
      403,
      "forbidden",
    );
    expect(stub.siteverifyCalls).toHaveLength(0);

    // 封禁（is_banned=1 直接命中 403；保持「封禁 + 请求在场」形态——手工恢复
    // hash，因为 setBanned(true) 的原子清栅栏契约由 store 层用例覆盖）
    await seedTurnstileReady(USER_ID);
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_banned = 1, verify_request_hash = ? WHERE bot_id = ? AND user_id = ?",
    ).bind(await sha256Hex(NONCE), BOT_ID, USER_ID).run();
    await expectError(
      await handleVerifySubmit(submitRequest(await submitBody()), envWith()),
      403,
      "forbidden",
    );
    expect(stub.siteverifyCalls).toHaveLength(0);
  });

  it("404：用户行不存在（/deluser 后）→ 绝不 ensureUser 重建", async () => {
    // 7799 从未建档
    const res = await handleVerifySubmit(submitRequest(await submitBody(7799)), envWith());
    await expectError(res, 404, "not_found");
    const row = await env.HODOR_DB.prepare(
      "SELECT bot_id FROM users WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, 7799).first();
    expect(row).toBeNull(); // 未被重建
  });

  it("409：配置切走（mode≠turnstile）/ 旧请求（hash 不符且无归属他人）/ 并发已消费 / 版本不符", async () => {
    await seedTurnstileReady();
    // 模式切走 → 配置变化 409
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "math" });
    await expectError(
      await handleVerifySubmit(submitRequest(await submitBody()), envWith()),
      409,
      "conflict",
    );
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "turnstile" });
    // 模式切回后 pending 已被清 → 重新播种；再测「旧请求」：提交一个不在库的 nonce
    await seedTurnstileReady();
    await expectError(
      await handleVerifySubmit(
        submitRequest({ requestId: "d".repeat(64), initData: await buildInitData(USER_ID), turnstileToken: "tok" }),
        envWith(),
      ),
      409,
      "conflict",
    );
    // 版本不符（行内 generation 落后于 settings）
    const settings = await getVerificationSettings(env.HODOR_DB);
    await env.HODOR_DB.prepare(
      "UPDATE users SET verify_request_generation = ? WHERE bot_id = ? AND user_id = ?",
    ).bind(settings.verifyGeneration - 1, BOT_ID, USER_ID).run();
    await expectError(
      await handleVerifySubmit(submitRequest(await submitBody()), envWith()),
      409,
      "conflict",
    );
    expect(stub.siteverifyCalls).toHaveLength(0);
  });

  it("410：当前请求过期（expires_at 已过）", async () => {
    await seedTurnstileReady();
    await env.HODOR_DB.prepare(
      "UPDATE users SET verify_request_expires_at = ? WHERE bot_id = ? AND user_id = ?",
    ).bind(new Date(Date.now() - 1000).toISOString(), BOT_ID, USER_ID).run();
    await expectError(
      await handleVerifySubmit(submitRequest(await submitBody()), envWith()),
      410,
      "expired",
    );
    expect(stub.siteverifyCalls).toHaveLength(0);
  });

  it("422：token 被拒（success:false）/ Siteverify 上下文不匹配（cdata 错）", async () => {
    await seedTurnstileReady();
    stub.setSiteverify(() => ({ json: { success: false, "error-codes": ["invalid-input-response"] } }));
    await expectError(
      await handleVerifySubmit(submitRequest(await submitBody()), envWith()),
      422,
      "token_rejected",
    );

    // 上下文不匹配：success 但 cdata 不是本请求（伪造 cdata 不放行）
    await seedTurnstileReady();
    stub.setSiteverify(() => ({
      json: { success: true, hostname: "example.com", action: "hodor_verify", cdata: "forged" },
    }));
    await expectError(
      await handleVerifySubmit(submitRequest(await submitBody()), envWith()),
      422,
      "token_rejected",
    );
  });

  it("429：提交窗口占用 → Retry-After 头 + 零上游调用（冷却不提前清空）", async () => {
    await seedTurnstileReady();
    const notBefore = new Date(Date.now() + 10_000).toISOString();
    await env.HODOR_DB.prepare(
      "UPDATE users SET verify_submit_not_before = ? WHERE bot_id = ? AND user_id = ?",
    ).bind(notBefore, BOT_ID, USER_ID).run();
    const res = await handleVerifySubmit(submitRequest(await submitBody()), envWith());
    await expectError(res, 429, "too_many_requests");
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(15);
    expect(stub.siteverifyCalls).toHaveLength(0);
    // 失败后冷却保留（不由失败方清理）
    expect(
      (
        await env.HODOR_DB.prepare(
          "SELECT verify_submit_not_before FROM users WHERE bot_id = ? AND user_id = ?",
        ).bind(BOT_ID, USER_ID).first<{ verify_submit_not_before: string | null }>()
      )!.verify_submit_not_before,
    ).toBe(notBefore);
  });

  it("503：Siteverify 持续不可用（网络错误重试恰一次后放弃）/ bots 表空", async () => {
    await seedTurnstileReady();
    stub.setSiteverify(() => ({ throwError: true }));
    const res = await handleVerifySubmit(submitRequest(await submitBody()), envWith());
    await expectError(res, 503, "unavailable");
    expect(stub.siteverifyCalls).toHaveLength(2); // 重试恰好一次
    // 上游不可用不撤销请求（冷却保留，稍后重试）
    expect((await seedState())!.verify_request_hash).toBe(await sha256Hex(NONCE));

    await seedTurnstileReady();
    const emptyBotEnv = envWith();
    await env.HODOR_DB.prepare("DELETE FROM bots").run();
    await expectError(
      await handleVerifySubmit(submitRequest(await submitBody()), emptyBotEnv),
      503,
      "unavailable",
    );
    await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
  });

  it("503：TURNSTILE_SECRET_KEY 缺失（配置不齐，绝不带空凭据调用上游）", async () => {
    await seedTurnstileReady();
    await expectError(
      await handleVerifySubmit(submitRequest(await submitBody()), envWith({ TURNSTILE_SECRET_KEY: "" })),
      503,
      "unavailable",
    );
    expect(stub.siteverifyCalls).toHaveLength(0);
  });

  /** 读回当前用户行（用例内断言用） */
  async function seedState() {
    return env.HODOR_DB.prepare(
      "SELECT verify_request_hash FROM users WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, USER_ID).first<{ verify_request_hash: string | null }>();
  }
});
