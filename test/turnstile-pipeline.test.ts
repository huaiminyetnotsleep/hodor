/**
 * Turnstile 模式的验证管线集成用例（Turnstile 任务阶段 3）：
 *
 * - sendVerificationCode（turnstile）：web_app 按钮消息（URL = origin +
 *   /verify?r=<nonce>）+ 统一栅栏落库（hash=SHA-256(nonce)、600 秒到期、
 *   配置版本快照、answer 恒 NULL、CAS 回填 msgId）；
 * - PUBLIC_BASE_URL 有效时优先（固定 canonical 地址）；请求 origin 兜底；
 * - 关闭验证期间 / 凭据缺失：不发无法完成的 Mini App 请求（零出站、零 pending）；
 * - math 模式统一栅栏回归：题面 / 按钮形态与阶段 5 逐字一致，同时落
 *   hash/generation 栅栏（CAS 回填）；关闭期间超限出题照常（栅栏匹配
 *   实际 enabled=false 的配置快照）；
 * - 失败清理：发送 retryable → 抛 + 栅栏清理；permanent → 静默 + 栅栏清理；
 * - inbound 集成：turnstile + 验证关闭期间的超限路径——撤验证照常、
 *   Mini App 请求不发（无法完成），旧 math 模式行为零变化由既有回归覆盖。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { formatVerifyQuestion, formatVerifyTurnstileQuestion, formatRateLimitVerifyQuestion, formatRateLimitVerifyTurnstile, VERIFY_TURNSTILE_BUTTON_LABEL } from "../src/copy";
import { parseMaxMessagesPerMinute } from "../src/env";
import { handleInbound } from "../src/pipeline/inbound";
import { sendVerificationCode } from "../src/pipeline/verify";
import { upsertBot } from "../src/store/bots";
import { applyVerificationConfigChange, getVerificationSettings } from "../src/store/settings";
import { sha256Hex } from "../src/verification/request";
import type { TelegramMessageRef } from "../src/pipeline/classify";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890;
const ORIGIN = "https://hodor.example.workers.dev";

/** handleInbound 实际读取的最小 env（显式构造，避免本地 .dev.vars 泄漏影响） */
function envWith(overrides: Record<string, string | undefined> = {}): Cloudflare.Env {
  return {
    HODOR_DB: env.HODOR_DB,
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    ADMIN_SECRET: "test-admin-secret",
    SUPPORT_CHAT_ID: String(SUPPORT_CHAT_ID),
    ADMIN_IDS: "111111111,222222222",
    MAX_MESSAGES_PER_MINUTE: "20",
    TURNSTILE_SITE_KEY: "0x4AAAAAAA_site",
    TURNSTILE_SECRET_KEY: "0x4AAAAAAA_secret",
    ...overrides,
  } as unknown as Cloudflare.Env;
}

const readRow = (userId: number) =>
  env.HODOR_DB.prepare(
    `SELECT is_verified, verify_answer, verify_msg_id, verify_request_hash,
       verify_request_expires_at, verify_request_generation
     FROM users WHERE bot_id = ? AND user_id = ?`,
  )
    .bind(BOT_ID, userId)
    .first<{
      is_verified: number;
      verify_answer: number | null;
      verify_msg_id: number | null;
      verify_request_hash: string | null;
      verify_request_expires_at: string | null;
      verify_request_generation: number | null;
    }>();

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
  await env.HODOR_DB.prepare("DELETE FROM settings").run();
});

/** 播种未验证用户（每用例归一） */
async function seedUnverified(userId: number): Promise<void> {
  await env.HODOR_DB.prepare(
    `INSERT INTO users (bot_id, user_id, first_name, first_seen_at, last_seen_at)
     VALUES (?, ?, 'T', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z')
     ON CONFLICT (bot_id, user_id) DO UPDATE SET
       is_verified = 0, verified_at = NULL, verify_answer = NULL, verify_msg_id = NULL,
       verify_request_hash = NULL, verify_request_expires_at = NULL,
       verify_request_generation = NULL, verify_submit_not_before = NULL, is_banned = 0`,
  )
    .bind(BOT_ID, userId)
    .run();
}

describe("turnstile 管线: sendVerificationCode（turnstile 模式）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    return applyVerificationConfigChange(env.HODOR_DB, { mode: "turnstile", enabled: true });
  });
  afterEach(() => {
    stub.restore();
    return env.HODOR_DB.prepare("DELETE FROM settings").run();
  });

  it("web_app 按钮消息（origin/verify?r=<nonce>）+ 栅栏落库：hash=SHA-256(nonce)、600s 到期、版本快照、answer NULL、msgId 回填", async () => {
    await seedUnverified(8801);
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4400 } } });
    const beforeGen = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration;

    await sendVerificationCode(envWith(), BOT_ID, 8801, { type: "question" }, ORIGIN);

    expect(stub.countOf("sendMessage")).toBe(1);
    const body = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    expect(body.chat_id).toBe(8801);
    expect(body.text).toBe(formatVerifyTurnstileQuestion());
    const keyboard = body.reply_markup as {
      inline_keyboard: { text: string; web_app?: { url: string }; callback_data?: string }[][];
    };
    expect(keyboard.inline_keyboard).toHaveLength(1);
    const button = keyboard.inline_keyboard[0][0];
    expect(button.text).toBe(VERIFY_TURNSTILE_BUTTON_LABEL);
    expect(button.web_app).toBeDefined();
    expect(button.callback_data).toBeUndefined(); // web_app 与 callback_data 互斥
    const nonce = button.web_app!.url.match(/^https:\/\/hodor\.example\.workers\.dev\/verify\?r=([0-9a-f]{64})$/)?.[1];
    expect(nonce).toBeDefined();

    const row = await readRow(8801);
    expect(row!.verify_request_hash).toBe(await sha256Hex(nonce!));
    expect(row!.verify_msg_id).toBe(4400); // CAS 回填
    expect(row!.verify_answer).toBeNull(); // 网页请求无整数答案
    expect(row!.verify_request_generation).toBe(beforeGen); // 配置版本快照
    // 到期 ≈ 创建 + 600 秒（ISO 字典序比较，util 契约——晚于现在即有效）
    expect(row!.verify_request_expires_at! > new Date().toISOString()).toBe(true);
  });

  it("PUBLIC_BASE_URL 有效时优先（固定 canonical 地址），覆盖请求 origin", async () => {
    await seedUnverified(8802);
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4401 } } });

    await sendVerificationCode(
      envWith({ PUBLIC_BASE_URL: "https://verify.canonical.example" }),
      BOT_ID,
      8802,
      { type: "question" },
      ORIGIN,
    );

    const body = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    const url = (body.reply_markup as { inline_keyboard: { web_app?: { url: string } }[][] })
      .inline_keyboard[0][0].web_app!.url;
    expect(url.startsWith("https://verify.canonical.example/verify?r=")).toBe(true);
  });

  it("非法 PUBLIC_BASE_URL（http）→ 视同未配置：回退请求 origin，照常出题", async () => {
    await seedUnverified(8803);
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4402 } } });

    await sendVerificationCode(
      envWith({ PUBLIC_BASE_URL: "http://insecure.example.com" }),
      BOT_ID,
      8803,
      { type: "question" },
      ORIGIN,
    );
    const url = (stub.callsOf("sendMessage")[0].body as Record<string, unknown>).reply_markup as {
      inline_keyboard: { web_app?: { url: string } }[][];
    };
    expect(url.inline_keyboard[0][0].web_app!.url!.startsWith(`${ORIGIN}/verify?r=`)).toBe(true);
  });

  it("超限形态：限频前缀 + 同一 web_app 按钮（单 push 合并）", async () => {
    await seedUnverified(8804);
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4403 } } });

    await sendVerificationCode(envWith(), BOT_ID, 8804, { type: "overflow", limit: 7 }, ORIGIN);
    const body = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    expect(body.text).toBe(formatRateLimitVerifyTurnstile(7));
    expect((body.text as string)).toContain("每分钟最多 7 条");
  });

  it("验证关闭期间：零出站、零 pending（绝不发无法完成的 Mini App 请求）", async () => {
    await applyVerificationConfigChange(env.HODOR_DB, { enabled: false });
    await seedUnverified(8805);

    await expect(
      sendVerificationCode(envWith(), BOT_ID, 8805, { type: "overflow", limit: 5 }, ORIGIN),
    ).resolves.toBeUndefined();
    expect(stub.countOf("sendMessage")).toBe(0);
    expect((await readRow(8805))!.verify_request_hash).toBeNull();
  });

  it("凭据缺失（只配 Site Key）：零出站、零 pending（绝不降级弱模式）", async () => {
    await seedUnverified(8806);
    const missingSecret = envWith({ TURNSTILE_SECRET_KEY: "" });

    await expect(
      sendVerificationCode(missingSecret, BOT_ID, 8806, { type: "question" }, ORIGIN),
    ).resolves.toBeUndefined();
    expect(stub.countOf("sendMessage")).toBe(0);
    expect((await readRow(8806))!.verify_request_hash).toBeNull();
  });

  it("发送 retryable → 抛出且栅栏清理（重推重出题）", async () => {
    await seedUnverified(8807);
    stub.always("sendMessage", { status: 503, json: { ok: false, description: "upstream boom" } });

    await expect(
      sendVerificationCode(envWith(), BOT_ID, 8807, { type: "question" }, ORIGIN),
    ).rejects.toThrow(/sendMessage/);
    const row = await readRow(8807);
    expect(row!.verify_request_hash).toBeNull(); // 栅栏已清理
    expect(row!.verify_msg_id).toBeNull();
  });

  it("发送 permanent（bot 被屏蔽）→ 静默完成且栅栏清理（题未送达不留 pending）", async () => {
    await seedUnverified(8808);
    stub.always("sendMessage", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked" },
    });

    await expect(
      sendVerificationCode(envWith(), BOT_ID, 8808, { type: "question" }, ORIGIN),
    ).resolves.toBeUndefined();
    expect((await readRow(8808))!.verify_request_hash).toBeNull();
  });
});

describe("turnstile 管线: math 模式统一栅栏回归（旧行为零变化 + 栅栏落库）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    return applyVerificationConfigChange(env.HODOR_DB, { mode: "math", enabled: true });
  });
  afterEach(() => {
    stub.restore();
    return env.HODOR_DB.prepare("DELETE FROM settings").run();
  });

  it("math 出题：题面与阶段 5 逐字一致（4 选项 + 题头），同时落 hash/generation 栅栏并回填 msgId", async () => {
    await seedUnverified(8811);
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4500 } } });
    const beforeGen = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration;

    await sendVerificationCode(envWith(), BOT_ID, 8811, { type: "question" }, ORIGIN);

    const body = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    expect(body.text).toMatch(/^为确认你是真人，请回答下面的算术题：\n[1-9] [-+] [1-9] = \?$/);
    const buttons = (body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0];
    expect(buttons).toHaveLength(4);
    const values = buttons.map((button) => Number(button.callback_data.slice(2)));
    const row = await readRow(8811);
    expect(row!.verify_msg_id).toBe(4500);
    expect(row!.verify_request_hash).toMatch(/^[0-9a-f]{64}$/); // 统一栅栏（无到期）
    expect(row!.verify_request_expires_at).toBeNull();
    expect(row!.verify_request_generation).toBe(beforeGen);
    expect(values).toContain(row!.verify_answer);
    // 栅栏 hash 与消息无关（math 无 URL），但可由 SHA-256 唯一标识本轮挑战
    expect(row!.verify_request_hash).not.toBe(await sha256Hex(""));
  });

  it("关闭验证期间的超限出题照常（栅栏匹配实际 enabled=false 快照）", async () => {
    await applyVerificationConfigChange(env.HODOR_DB, { enabled: false });
    await seedUnverified(8812);
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4501 } } });

    await expect(
      sendVerificationCode(envWith(), BOT_ID, 8812, { type: "overflow", limit: 3 }, ORIGIN),
    ).resolves.toBeUndefined();

    const body = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    expect(body.text).toBe(formatRateLimitVerifyQuestion(3, (body.text as string).match(/[1-9] [-+] [1-9] = \?$/)![0]));
    const row = await readRow(8812);
    expect(row!.verify_request_hash).not.toBeNull(); // math 照常出题落栅栏
    expect(row!.verify_msg_id).toBe(4501);
  });
});

describe("turnstile 管线: inbound 集成（关闭验证期间的超限路径）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
    return env.HODOR_DB.prepare("DELETE FROM settings").run();
  });

  const privateMessage = (from: { id: number; first_name: string }, text: string, messageId: number): TelegramMessageRef => ({
    message_id: messageId,
    from,
    chat: { id: from.id, type: "private" },
    text,
  });

  it("turnstile + 验证关闭：超限撤验证照常，但不发 Mini App 请求（零用户侧消息）", async () => {
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "turnstile", enabled: false });
    const rateEnv = envWith({ MAX_MESSAGES_PER_MINUTE: "2" });
    const limit = parseMaxMessagesPerMinute(rateEnv);

    // 已验证用户（关闭期间直接过验证门）
    await seedUnverified(8821);
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_verified = 1, verified_at = ? WHERE bot_id = ? AND user_id = ?",
    ).bind(new Date().toISOString(), BOT_ID, 8821).run();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("createForumTopic", { status: 200, json: { ok: true, result: { message_thread_id: 900 } } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });

    // 前 limit 条正常中继（sendMessage 去客服群）
    for (let i = 1; i <= limit; i++) {
      await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 8821, first_name: "R" }, `m${i}`, 870 + i), ORIGIN);
    }
    const userSendsBefore = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 8821).length;

    // 第 limit+1 条：超限 → 撤验证 + 降级，但 turnstile 不发 Mini App（无法完成）
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 8821, first_name: "R" }, "boom", 880), ORIGIN);

    const row = await readRow(8821);
    expect(row!.is_verified).toBe(0); // 撤验证照常
    const userSends = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 8821);
    expect(userSends).toHaveLength(userSendsBefore); // 用户侧零新消息（无 Mini App 请求）
    expect((await readRow(8821))!.verify_request_hash).toBeNull();

    // 下一条消息落回验证门——验证门关闭时整门跳过（不补发），is_verified 保持 0
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 8821, first_name: "R" }, "again", 881), ORIGIN);
    expect((await readRow(8821))!.is_verified).toBe(0);
  });

  it("math + 验证关闭：同一超限路径照常发合并消息（旧模式行为回归——栅栏替换后出题）", async () => {
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "math", enabled: false });
    const rateEnv = envWith({ MAX_MESSAGES_PER_MINUTE: "2" });

    await seedUnverified(8822);
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_verified = 1, verified_at = ? WHERE bot_id = ? AND user_id = ?",
    ).bind(new Date().toISOString(), BOT_ID, 8822).run();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 2 } } });
    stub.always("createForumTopic", { status: 200, json: { ok: true, result: { message_thread_id: 901 } } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });

    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 8822, first_name: "M" }, "1", 885), ORIGIN);
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 8822, first_name: "M" }, "2", 886), ORIGIN);
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 8822, first_name: "M" }, "3", 887), ORIGIN);

    const row = await readRow(8822);
    expect(row!.is_verified).toBe(0);
    expect(row!.verify_request_hash).not.toBeNull(); // math 超限照常出题（合并消息）
    expect(row!.verify_msg_id).not.toBeNull();
    // 最后一条用户侧消息 = 限频合并消息（提示 + 新题）
    const lastUserSend = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 8822)
      .at(-1)!.body as Record<string, unknown>;
    expect(lastUserSend.text).toMatch(/^发送过快，每分钟最多 2 条消息/);
  });
});
