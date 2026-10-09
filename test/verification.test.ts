/**
 * 验证模块纯函数用例（Turnstile 任务阶段 4）：
 *
 * - validateTelegramInitData：**独立固定向量**（由一次性 Node 脚本按官方
 *   文档算法生成，见脚本注释；实现与生成器零共享代码，杜绝「自签自验」）
 *   覆盖合法 / 含 signature / 错误 Bot Token / 篡改 user / 年龄与未来偏差
 *   边界；另以测试内独立 WebCrypto 签名助手（与被测模块不同实现）补齐
 *   结构破坏类用例（重复键 / 缺字段 / 畸形编码 / 非法 user / 超长输入）。
 * - request 助手：nonce 格式、SHA-256 已知向量、createVerifyRequest 的
 *   hash 一致性与 600 秒到期。
 * - verifyTurnstileToken：mock fetchImpl 全分支（passed / rejected /
 *   上下文不匹配 / 临时失败恰好重试一次且复用 idempotency_key / 4xx 不可用
 *   不重试 / internal-error 视为临时）。
 * - renderVerifyPage：CSP nonce / 转义 / 官方来源 / 不设 frame-ancestors
 *   'none' / 绝不包含 Secret 形态的输出。
 */
import { describe, expect, it } from "vitest";
import {
  INIT_DATA_AGE_300_OK,
  INIT_DATA_AGE_301_EXPIRED,
  INIT_DATA_FUTURE_30_OK,
  INIT_DATA_FUTURE_31_REJECTED,
  INIT_DATA_MINIMAL,
  INIT_DATA_NOW_SECONDS,
  INIT_DATA_OTHER_TOKEN,
  INIT_DATA_TAMPERED_USER,
  INIT_DATA_TEST_TOKEN,
  INIT_DATA_VALID,
  INIT_DATA_VALID_WITH_SIGNATURE,
  INIT_DATA_WRONG_TOKEN,
} from "./fixtures/initDataVectors";
import { renderVerifyPage } from "../src/verification/page";
import { createVerifyRequest, isVerifyNonceFormat, sha256Hex } from "../src/verification/request";
import { validateTelegramInitData } from "../src/verification/telegramInitData";
import {
  generateIdempotencyKey,
  TURNSTILE_ACTION,
  verifyTurnstileToken,
  type SiteverifyParams,
} from "../src/verification/turnstile";

/** 固定「当前时间」（与向量生成时刻一致）：1700000000 秒 + 半秒余量 */
const NOW_MS = INIT_DATA_NOW_SECONDS * 1000;

/* ------------------------------------------------------------------ */
/* 独立 WebCrypto 签名助手（测试专用、与被测模块零共享实现）             */
/* ------------------------------------------------------------------ */

async function hmacHex(key: ArrayBuffer, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 按官方算法签名一组「解码后」字段（测试侧独立实现，供结构破坏类用例） */
async function signInitData(
  fields: Record<string, string>,
  botToken: string,
): Promise<string> {
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
    .filter(([key]) => key !== "hash")
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return hmacHex(secret, check);
}

/* ------------------------------------------------------------------ */
/* initData：固定独立向量                                               */
/* ------------------------------------------------------------------ */

describe("verification: validateTelegramInitData（独立固定向量）", () => {
  it("官方算法向量（含非 ASCII 用户 + query_id）→ ok，id=7701", async () => {
    const result = await validateTelegramInitData(INIT_DATA_VALID, INIT_DATA_TEST_TOKEN, NOW_MS);
    expect(result).toEqual({ ok: true, userId: 7701, authDate: INIT_DATA_NOW_SECONDS });
  });

  it("含 signature 字段的向量 → HMAC 路径包含 signature（非 Ed25519 排除规则）", async () => {
    const result = await validateTelegramInitData(
      INIT_DATA_VALID_WITH_SIGNATURE,
      INIT_DATA_TEST_TOKEN,
      NOW_MS,
    );
    expect(result).toEqual({ ok: true, userId: 7701, authDate: INIT_DATA_NOW_SECONDS });
  });

  it("错误 Bot Token 签发的向量 → signature 失败（绝不放行）", async () => {
    const result = await validateTelegramInitData(INIT_DATA_WRONG_TOKEN, INIT_DATA_TEST_TOKEN, NOW_MS);
    expect(result).toEqual({ ok: false, reason: "signature" });
    // 反向：用签发 token 验证则通过（证明失败源于 token 不匹配而非载荷问题）
    await expect(
      validateTelegramInitData(INIT_DATA_WRONG_TOKEN, INIT_DATA_OTHER_TOKEN, NOW_MS),
    ).resolves.toMatchObject({ ok: true, userId: 7701 });
  });

  it("篡改 user（id 换人、hash 沿用旧值）→ signature 失败（改写用户无效）", async () => {
    const result = await validateTelegramInitData(INIT_DATA_TAMPERED_USER, INIT_DATA_TEST_TOKEN, NOW_MS);
    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("极简字段（仅 auth_date + user）→ ok", async () => {
    await expect(
      validateTelegramInitData(INIT_DATA_MINIMAL, INIT_DATA_TEST_TOKEN, NOW_MS),
    ).resolves.toMatchObject({ ok: true, userId: 7701 });
  });

  it("年龄边界：恰好 300 秒 → 接受；301 秒 → expired（须关闭重开）", async () => {
    await expect(
      validateTelegramInitData(INIT_DATA_AGE_300_OK, INIT_DATA_TEST_TOKEN, NOW_MS),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateTelegramInitData(INIT_DATA_AGE_301_EXPIRED, INIT_DATA_TEST_TOKEN, NOW_MS),
    ).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("未来偏差边界：+30 秒 → 接受；+31 秒 → 拒绝（防时钟伪造）", async () => {
    await expect(
      validateTelegramInitData(INIT_DATA_FUTURE_30_OK, INIT_DATA_TEST_TOKEN, NOW_MS),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateTelegramInitData(INIT_DATA_FUTURE_31_REJECTED, INIT_DATA_TEST_TOKEN, NOW_MS),
    ).resolves.toEqual({ ok: false, reason: "expired" });
  });
});

describe("verification: validateTelegramInitData（结构破坏，独立签名助手）", () => {
  /** 以独立助手构造「解码字段集」的 initData 原始串 */
  async function buildRaw(fields: Record<string, string>, token = INIT_DATA_TEST_TOKEN): Promise<string> {
    const withHash = { ...fields, hash: await signInitData(fields, token) };
    return Object.entries(withHash)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
  }

  it("重复键 → format（绝不猜语义）", async () => {
    const base = await buildRaw({
      auth_date: String(INIT_DATA_NOW_SECONDS),
      user: JSON.stringify({ id: 7701 }),
    });
    const tampered = base.replace("auth_date=", `auth_date=1&auth_date=`);
    await expect(
      validateTelegramInitData(tampered, INIT_DATA_TEST_TOKEN, NOW_MS),
    ).resolves.toEqual({ ok: false, reason: "format" });
  });

  it("缺 hash / 缺 auth_date / 缺 user → format", async () => {
    const noHash = "auth_date=1&user=%7B%22id%22%3A7701%7D";
    const noAuthDate = `user=%7B%22id%22%3A7701%7D&hash=${"0".repeat(64)}`;
    const noUser = `auth_date=1&hash=${"0".repeat(64)}`;
    for (const raw of [noHash, noAuthDate, noUser]) {
      await expect(
        validateTelegramInitData(raw, INIT_DATA_TEST_TOKEN, NOW_MS),
      ).resolves.toEqual({ ok: false, reason: "format" });
    }
  });

  it("畸形百分号编码 → format（有界解析拒绝异常编码）", async () => {
    await expect(
      validateTelegramInitData("auth_date=%ZZ&user=x&hash=ff", INIT_DATA_TEST_TOKEN, NOW_MS),
    ).resolves.toEqual({ ok: false, reason: "format" });
  });

  it("user.id 非正整数（字符串 / 负数 / 缺失）→ format（签名合法也不放行）", async () => {
    for (const id of ["abc", -5, 1.5]) {
      const userJson = JSON.stringify(id === "abc" ? { id: "abc" } : id === -5 ? { id: -5 } : { id: 1.5 });
      const raw = await buildRaw({
        auth_date: String(INIT_DATA_NOW_SECONDS),
        user: userJson,
      });
      await expect(
        validateTelegramInitData(raw, INIT_DATA_TEST_TOKEN, NOW_MS),
      ).resolves.toEqual({ ok: false, reason: "format" });
    }
  });

  it("超长输入（> 8 KiB）→ format；空串 → format", async () => {
    const junk = `x=${"a".repeat(9 * 1024)}&hash=${"0".repeat(64)}`;
    await expect(
      validateTelegramInitData(junk, INIT_DATA_TEST_TOKEN, NOW_MS),
    ).resolves.toEqual({ ok: false, reason: "format" });
    await expect(
      validateTelegramInitData("", INIT_DATA_TEST_TOKEN, NOW_MS),
    ).resolves.toEqual({ ok: false, reason: "format" });
  });
});

/* ------------------------------------------------------------------ */
/* request 助手                                                        */
/* ------------------------------------------------------------------ */

describe("verification: request 助手", () => {
  it("isVerifyNonceFormat：64 小写十六进制；其余拒绝", () => {
    expect(isVerifyNonceFormat("a".repeat(64))).toBe(true);
    expect(isVerifyNonceFormat("0123456789abcdef".repeat(4))).toBe(true);
    expect(isVerifyNonceFormat("A".repeat(64))).toBe(false); // 大写拒绝
    expect(isVerifyNonceFormat("a".repeat(63))).toBe(false);
    expect(isVerifyNonceFormat("g".repeat(64))).toBe(false);
    expect(isVerifyNonceFormat(undefined)).toBe(false);
    expect(isVerifyNonceFormat(123)).toBe(false);
  });

  it("sha256Hex：与已知标准向量一致（'abc'）", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("createVerifyRequest：nonce 64 hex、hash=SHA-256(nonce)、600 秒到期；ttl null → 无到期", async () => {
    const now = new Date("2026-10-09T00:00:00.000Z");
    const request = await createVerifyRequest(now, 600_000);
    expect(request.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(request.hash).toBe(await sha256Hex(request.nonce));
    expect(request.expiresAt).toBe("2026-10-09T00:10:00.000Z");

    const noTtl = await createVerifyRequest(now, null);
    expect(noTtl.expiresAt).toBeNull(); // math / button 不新增题目超时
    // 两次生成互异（随机性）
    expect(noTtl.nonce).not.toBe(request.nonce);
  });
});

/* ------------------------------------------------------------------ */
/* Turnstile Siteverify 客户端（mock fetchImpl 全分支）                 */
/* ------------------------------------------------------------------ */

function siteverifyParams(overrides: Partial<SiteverifyParams> = {}): SiteverifyParams {
  return {
    secret: "secret-key",
    token: "tok",
    expectedHostname: "hodor.example.workers.dev",
    expectedAction: TURNSTILE_ACTION,
    expectedCdata: "c".repeat(64),
    ...overrides,
  };
}

/** mock fetch：按脚本逐次返回（记录请求体供断言） */
function mockFetch(script: Array<{ status?: number; body?: unknown; throw?: boolean; raw?: string }>) {
  const calls: { body: unknown; key: unknown }[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push({ body: JSON.parse(String(init?.body)), key: (JSON.parse(String(init?.body)) as { idempotency_key?: string }).idempotency_key });
    if (step.throw) throw new Error("simulated network failure");
    if (step.raw !== undefined) {
      return new Response(step.raw, { status: step.status ?? 200, headers: { "content-type": "text/plain" } });
    }
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const SUCCESS_BODY = {
  success: true,
  hostname: "hodor.example.workers.dev",
  action: TURNSTILE_ACTION,
  cdata: "c".repeat(64),
};

describe("verification: verifyTurnstileToken", () => {
  it("success + hostname/action/cdata 全匹配 → passed；请求体携带 secret/response/idempotency_key", async () => {
    const mock = mockFetch([{ status: 200, body: SUCCESS_BODY }]);
    await expect(verifyTurnstileToken(siteverifyParams(), mock.impl)).resolves.toEqual({
      status: "passed",
    });
    expect(mock.calls).toHaveLength(1);
    const body = mock.calls[0].body as Record<string, unknown>;
    expect(body.secret).toBe("secret-key");
    expect(body.response).toBe("tok");
    expect(typeof body.idempotency_key).toBe("string");
    expect(mock.calls[0].key).toBeTruthy();
  });

  it("success 但 hostname / action / cdata 任一不匹配 → rejected（context-mismatch）", async () => {
    for (const body of [
      { ...SUCCESS_BODY, hostname: "evil.example.com" },
      { ...SUCCESS_BODY, action: "other_action" },
      { ...SUCCESS_BODY, cdata: "forged" },
    ]) {
      const mock = mockFetch([{ status: 200, body }]);
      await expect(verifyTurnstileToken(siteverifyParams(), mock.impl)).resolves.toEqual({
        status: "rejected",
        errorCodes: ["context-mismatch"],
      });
    }
  });

  it("success:false → rejected 透传 error-codes（token 无效 / 已消费）", async () => {
    const mock = mockFetch([
      { status: 200, body: { success: false, "error-codes": ["timeout-or-duplicate"] } },
    ]);
    await expect(verifyTurnstileToken(siteverifyParams(), mock.impl)).resolves.toEqual({
      status: "rejected",
      errorCodes: ["timeout-or-duplicate"],
    });
    expect(mock.calls).toHaveLength(1); // 明确拒绝不重试
  });

  it("网络错误 → 同一 idempotency_key 重试恰好一次；仍失败 → unavailable", async () => {
    const mock = mockFetch([{ throw: true }, { throw: true }]);
    await expect(verifyTurnstileToken(siteverifyParams(), mock.impl)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(mock.calls).toHaveLength(2); // 绝不重试两次
    expect(mock.calls[0].key).toBe(mock.calls[1].key); // 同操作复用 key
  });

  it("首试 5xx → 重试成功 → passed（同 key）", async () => {
    const mock = mockFetch([
      { status: 500, body: { success: false } },
      { status: 200, body: SUCCESS_BODY },
    ]);
    await expect(verifyTurnstileToken(siteverifyParams(), mock.impl)).resolves.toEqual({
      status: "passed",
    });
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0].key).toBe(mock.calls[1].key);
  });

  it("internal-error 属临时 → 重试一次；仍 internal-error → unavailable", async () => {
    const mock = mockFetch([
      { status: 200, body: { success: false, "error-codes": ["internal-error"] } },
      { status: 200, body: { success: false, "error-codes": ["internal-error"] } },
    ]);
    await expect(verifyTurnstileToken(siteverifyParams(), mock.impl)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(mock.calls).toHaveLength(2);
  });

  it("非 JSON 响应属临时 → 重试；4xx（非 5xx）→ unavailable 且不重试", async () => {
    const nonJson = mockFetch([{ status: 200, raw: "<html>not json</html>" }, { status: 200, raw: "<html>again</html>" }]);
    await expect(verifyTurnstileToken(siteverifyParams(), nonJson.impl)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(nonJson.calls).toHaveLength(2);

    const badRequest = mockFetch([{ status: 400, body: { success: false } }]);
    await expect(verifyTurnstileToken(siteverifyParams(), badRequest.impl)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(badRequest.calls).toHaveLength(1);
  });

  it("generateIdempotencyKey：UUID 形态、互异", () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

/* ------------------------------------------------------------------ */
/* 验证页面渲染                                                        */
/* ------------------------------------------------------------------ */

describe("verification: renderVerifyPage", () => {
  const requestId = "c".repeat(64);
  const rendered = renderVerifyPage({ requestId, siteKey: "0x4AAAAAAA_site_key" });

  it("CSP：script/frame 限官方两域 + nonce；不设 frame-ancestors 'none'（Mini App 需嵌入）", () => {
    expect(rendered.csp).toContain(`script-src https://telegram.org https://challenges.cloudflare.com 'nonce-${rendered.cspNonce}'`);
    expect(rendered.csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(rendered.csp).toContain("connect-src 'self'");
    expect(rendered.csp).toContain("default-src 'none'");
    expect(rendered.csp).not.toContain("frame-ancestors");
    expect(rendered.html).not.toContain("X-Frame-Options");
  });

  it("页面包含公开 Site Key 与 requestId；绝不包含 Secret 形态输出", () => {
    expect(rendered.html).toContain("0x4AAAAAAA_site_key");
    expect(rendered.html).toContain(requestId);
    expect(rendered.html).toContain("https://telegram.org/js/telegram-web-app.js");
    expect(rendered.html).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(rendered.html).toContain("hodor_verify"); // action 固定
  });

  it("动态值转义：恶意形态输入被转义（正常调用前已有格式校验，防御式断言）", () => {
    const escaped = renderVerifyPage({ requestId: "c".repeat(64), siteKey: '"><script>alert(1)</script>' });
    expect(escaped.html).not.toContain('"><script>');
    expect(escaped.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("状态文案齐备：缺 initData / 身份过期 / 链接过期 / 用户不符 / 可重试故障", () => {
    for (const marker of [
      "从 Bot 聊天窗口",
      "身份信息已过期",
      "验证链接已过期或已被使用",
      "当前账号与验证请求不符",
      "验证服务暂时不可用",
      "验证通过",
    ]) {
      expect(rendered.html).toContain(marker);
    }
  });
});
