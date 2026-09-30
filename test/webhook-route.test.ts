/**
 * POST /webhook 路由集成（T15/T16/T17 + 阶段 3 媒体回归 + 阶段 4 未验证拦截 /
 * callback 端到端 / T18 429 有界重试）：头鉴权 401 统一、毒丸 200、bots 未绑定
 * 500、幂等认领全分支（duplicate / in-flight / poison / owned）、已验证用户
 * inbound 全链路（建档 + 建 topic + 置顶 + 单次中继 + 账本 + markProcessed）、
 * 未验证首条消息拦截（欢迎 + 验证题，零 topic）、callback_query 端到端
 * （答对放行 / 畸形 200 吞 / 旧题失效）与 T18（持续 429 → 重推接管 →
 * 毒丸收敛；retry_after > 3s 不原地等待）。
 *
 * 经 SELF.fetch 走完整 worker 入口；Telegram 出站全部经 telegramFetchStub 拦截，
 * 未注册响应器的调用直接抛错——测试内绝无真实网络。
 * vitest.config.ts 已显式注入 MAX_ATTEMPTS="3"（.dev.vars 不再泄漏进 worker
 * env）；毒丸用例的上限值仍从 parseMaxAttempts(env) 动态取，与 worker 同源。
 *
 * 阶段 3 调整说明：首条文本 / 重推去重 / 部分成功窗口三个阶段 2 用例的
 * sendMessage 计数按新全链（置顶信息 + 中继）更新——「中继恰一次且带 thread」
 * 「不双发」「绝不提前标记」的原始断言意图全部保留。
 *
 * 阶段 4 调整说明：inbound 全链 / 媒体 / 部分成功窗口用例的用户改为
 * seedVerified（is_verified=1 播种）——三门交付后 topic/中继/账本仅已验证用户
 * 可达，原断言意图不变；新用户首条消息的行为单独固化为「未验证拦截」用例。
 *
 * T18 用例说明：重推的「60s 过期接管」用 created_at 倒填模拟时间流逝
 * （STALE_CLAIM_MS 窗口），投递序列与真实 Telegram 重推完全同构；每轮失败
 * 投递恰 2 次 sendMessage fetch（429 retry_after ≤ 3s 原地重试恰一次）。
 */
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseMaxAttempts } from "../src/env";
import {
  VERIFY_EXPIRED_NOTICE,
  VERIFY_PASSED_TEXT,
  VERIFY_PASSED_TOAST,
} from "../src/copy";
import { handleWebhook } from "../src/routes/webhook";
import { upsertBot } from "../src/store/bots";
import { ensureUser, setPendingVerification } from "../src/store/users";
import { insertTopic } from "../src/store/topics";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET; // 'test-webhook-secret'
const SUPPORT_CHAT_ID = -1001234567890;
const ADMIN_ID = 111111111;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

function postWebhook(body: unknown, secret: string | null = WEBHOOK_SECRET): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return SELF.fetch("https://example.com/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 用户私聊文本 update */
function inboundUpdate(updateId: number, userId: number): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      from: { id: userId, first_name: "Zoe", username: "zoe_hd" },
      chat: { id: userId, type: "private" },
      text: "hello support",
      date: 1700000000,
    },
  };
}

/** 播种已验证用户（阶段 4：inbound 全链仅已验证用户可达） */
async function seedVerified(userId: number): Promise<void> {
  await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: "Zoe", username: "zoe_hd" });
  await env.HODOR_DB.prepare(
    "UPDATE users SET is_verified = 1, verified_at = ? WHERE bot_id = ? AND user_id = ?",
  )
    .bind(new Date().toISOString(), BOT_ID, userId)
    .run();
}

const readProcessed = (updateId: number) =>
  env.HODOR_DB.prepare(
    "SELECT status, attempts FROM processed_updates WHERE bot_id = ? AND update_id = ?",
  )
    .bind(BOT_ID, updateId)
    .first<{ status: string; attempts: number }>();

describe("POST /webhook: 鉴权与解析", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("头缺失 / 头错误 / 非 Telegram 形态 → 统一 401，零 DB 写、零出站调用", async () => {
    // 行数快照（用例间共享 DB，断言「不变」而非绝对值）
    const counts = async () => {
      const q = async (sql: string) =>
        (await env.HODOR_DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
      return {
        users: await q("SELECT COUNT(*) AS n FROM users"),
        topics: await q("SELECT COUNT(*) AS n FROM topics"),
        processed: await q("SELECT COUNT(*) AS n FROM processed_updates"),
      };
    };
    const before = await counts();

    const missing = await postWebhook(inboundUpdate(9001, 7301), null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const wrong = await postWebhook(inboundUpdate(9001, 7301), "wrong-secret");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });

    expect(await counts()).toEqual(before);
    expect(stub.countOf("sendMessage")).toBe(0);
  });

  it("body 非 JSON / 合法 JSON 但无 update_id → 毒丸 200（重推无意义，不吞重试队列）", async () => {
    const processedBefore =
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM processed_updates").first<{ n: number }>())?.n ?? 0;

    const badJson = await postWebhook("{not-json");
    expect(badJson.status).toBe(200);

    const noId = await postWebhook({ message: { chat: { id: 7301, type: "private" } } });
    expect(noId.status).toBe(200);

    const processedAfter =
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM processed_updates").first<{ n: number }>())?.n ?? 0;
    expect(processedAfter).toBe(processedBefore);
    expect(stub.countOf("sendMessage")).toBe(0);
  });

  it("env 缺 TELEGRAM_WEBHOOK_SECRET → 与错误密钥完全同一的 401（handler 直调：SELF bindings 固定）", async () => {
    // 直调 handler（SELF.fetch 的 bindings 不可改），构造缺 secret 的 env：
    // 呈现的密钥值本身合法，但 env 无期望值 → 必须 401，且与错误密钥零区分
    const partialEnv = {
      HODOR_DB: env.HODOR_DB,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    } as unknown as Cloudflare.Env;
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(inboundUpdate(9199, 7399)),
    });

    const missing = await handleWebhook(request, partialEnv);
    expect(missing.status).toBe(401);
    const missingBody = await missing.json();
    expect(missingBody).toEqual({ error: "unauthorized" });

    // 与错误密钥的 401 body 逐字一致（对外不区分「缺配置」与「密钥错误」）
    const wrong = await postWebhook(inboundUpdate(9198, 7398), "wrong-secret");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(missingBody);

    // 两路径都零 DB 写（未认领）零出站
    expect(await readProcessed(9199)).toBeNull();
    expect(stub.countOf("sendMessage")).toBe(0);
  });

  it("GET /webhook（方法不符）→ 404，零出站", async () => {
    const res = await SELF.fetch("https://example.com/webhook");
    expect(res.status).toBe(404);
    expect(stub.countOf("sendMessage")).toBe(0);
  });

  it("bots 表空（尚未 setwebhook）→ 500，processed_updates 不落行", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    await env.HODOR_DB.prepare("DELETE FROM bots").run();

    const res = await postWebhook(inboundUpdate(9002, 7302));
    expect(res.status).toBe(500);
    expect(await readProcessed(9002)).toBeNull();
    expect(stub.countOf("sendMessage")).toBe(0);

    // 自愈：补回 bots 行，后续用例不受影响
    await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
  });
});

describe("POST /webhook: inbound 全链路与幂等认领", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("合法密钥 + 已验证用户首条文本 → 200；建档 + 建 topic + 置顶 + 中继恰一次 + processed", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 800 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });

    await seedVerified(7301);
    const res = await postWebhook(inboundUpdate(9101, 7301));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });

    // 三表落行
    const user = await env.HODOR_DB.prepare(
      "SELECT first_name, username FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7301)
      .first<{ first_name: string; username: string }>();
    expect(user).toEqual({ first_name: "Zoe", username: "zoe_hd" });
    const topic = await env.HODOR_DB.prepare(
      "SELECT thread_id, status, pinned_msg_id FROM topics WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7301)
      .first<{ thread_id: number; status: string; pinned_msg_id: number }>();
    expect(topic).toEqual({ thread_id: 800, status: "open", pinned_msg_id: 1 });
    expect(await readProcessed(9101)).toEqual({ status: "processed", attempts: 0 });

    // 已验证非 start 全链恰 2 次 sendMessage：置顶信息 + 中继（欢迎语属首联包）
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("sendMessage")).toBe(2);
    expect(stub.countOf("pinChatMessage")).toBe(1);
    // 中继恰一次且带 thread（精确键集：sendMessage + text + thread，无 from_* 键）
    const relay = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).text === "hello support");
    expect(relay).toHaveLength(1);
    expect(relay[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: "hello support",
      message_thread_id: 800,
    });
    // 账本 in 行
    const ledger = await env.HODOR_DB.prepare(
      "SELECT direction, group_msg_id, private_msg_id, content_type FROM messages WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7301)
      .first<{ direction: string; group_msg_id: number; private_msg_id: number; content_type: string }>();
    expect(ledger).toEqual({ direction: "in", group_msg_id: 1, private_msg_id: 10, content_type: "text" });
  });

  it("未验证新用户首条消息（阶段 4 验证门）：200 + processed，首联包（欢迎 + 验证题各一条），零 topic / 零中继 / 零账本", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 2 } } });
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 805 } },
    });

    const res = await postWebhook(inboundUpdate(9115, 7315));
    expect(res.status).toBe(200);
    expect(await readProcessed(9115)).toEqual({ status: "processed", attempts: 0 });

    // 首联包：欢迎语 + 验证题（带 4 按钮）恰各一条，全部发用户私聊
    const toUser = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7315);
    expect(toUser).toHaveLength(2);
    expect((toUser[0].body as Record<string, unknown>).reply_markup).toBeUndefined(); // 欢迎语
    const question = toUser[1].body as Record<string, unknown>;
    const buttons = (question.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard[0];
    expect(buttons).toHaveLength(4);
    // 零 topic 副作用 / 零账本（被拦截 = 按成功处理）
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("pinChatMessage")).toBe(0);
    const topicRow = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM topics WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7315)
      .first<{ n: number }>();
    expect(topicRow!.n).toBe(0);
    const ledger = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7315)
      .first<{ n: number }>();
    expect(ledger!.n).toBe(0);
  });

  it("同一 update_id 重推 → duplicate 200，零新副作用（sendMessage 零新增调用）", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 801 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });

    await seedVerified(7302);
    const first = await postWebhook(inboundUpdate(9102, 7302));
    expect(first.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(2);

    const replay = await postWebhook(inboundUpdate(9102, 7302));
    expect(replay.status).toBe(200);
    // 重放不再触发任何 Telegram 调用
    expect(stub.countOf("sendMessage")).toBe(2);
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("pinChatMessage")).toBe(1);
    expect(await readProcessed(9102)).toEqual({ status: "processed", attempts: 0 });
  });

  it("并发同 id（首次失败留 processing 未标记）→ 第二次 500 in-flight，不双发", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 802 } },
    });
    // sendMessage 一直 5xx（retryable）→ 首次处理在置顶信息步骤即失败
    //（全链中它先于中继——失败点更早，不双发语义不变）
    stub.always("sendMessage", { status: 503, json: { ok: false, description: "unavailable" } });

    await seedVerified(7303);
    const first = await postWebhook(inboundUpdate(9103, 7303));
    expect(first.status).toBe(500);
    // 失败保持 processing（未提前标记，attempts=0），交由重推接管
    expect(await readProcessed(9103)).toEqual({ status: "processing", attempts: 0 });
    expect(stub.countOf("sendMessage")).toBe(1);

    // 未过期的在途认领：第二次投递 500 交 Telegram 稍后再推，绝不双发
    const second = await postWebhook(inboundUpdate(9103, 7303));
    expect(second.status).toBe(500);
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(await readProcessed(9103)).toEqual({ status: "processing", attempts: 0 });
  });

  it("毒丸路径：过期接管后 attempts 达 MAX_ATTEMPTS → markFailed + 200 跳过，零中继", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    // 上限从 parseMaxAttempts(env) 动态取（vitest.config.ts 固定注入 "3"），
    // 与 worker 侧计算保持同源，避免配置漂移时用例失真
    const maxAttempts = parseMaxAttempts(env);
    // 预置：崩溃残留行 attempts = max-1 且认领已过期（>60s）→ 本次接管即达上限
    await env.HODOR_DB.prepare(
      "INSERT INTO processed_updates (bot_id, update_id, status, attempts, created_at) VALUES (?, 9104, 'processing', ?, ?)",
    )
      .bind(BOT_ID, maxAttempts - 1, new Date(Date.now() - 61_000).toISOString())
      .run();

    const res = await postWebhook(inboundUpdate(9104, 7304));
    expect(res.status).toBe(200);
    expect(await readProcessed(9104)).toEqual({ status: "failed", attempts: maxAttempts });
    expect(stub.countOf("sendMessage")).toBe(0);

    // failed 后再重推 → duplicate 直接 200
    const replay = await postWebhook(inboundUpdate(9104, 7304));
    expect(replay.status).toBe(200);
    expect(await readProcessed(9104)).toEqual({ status: "failed", attempts: maxAttempts });
  });

  it("classify=ignore（客服群无 thread）→ 安全忽略 200 + processed，零出站", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    const generalChatUpdate = {
      update_id: 9105,
      message: {
        message_id: 20,
        from: { id: ADMIN_ID, first_name: "Admin" },
        chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
        text: "闲聊不走 topic",
        date: 1700000000,
      },
    };

    const res = await postWebhook(generalChatUpdate);
    expect(res.status).toBe(200);
    expect(await readProcessed(9105)).toEqual({ status: "processed", attempts: 0 });
    expect(stub.countOf("sendMessage")).toBe(0);
  });

  it("部分成功窗口（PRD T16 / design.md）：已送达未标记 → 过期接管重发一次、复用 topic、最终 processed", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 999 } },
    });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });

    // 模拟「投递 #1」的崩溃现场（design.md 部分成功窗口）：建档与映射行已写、
    // sendMessage 已送达，但 markProcessed 前崩溃 → 行停在 processing(attempts=0)
    // 且认领已过期(>60s)。入站在 sendMessage 之后没有任何可失败点，
    // 故用真实 store 函数预置该状态（ensureUser + insertTopic + 过期 processing 行），
    // 这是该崩溃点最忠实的可达表示——测试固化的正是「绝不提前标记」的代价。
    const userId = 7305;
    await seedVerified(userId);
    await insertTopic(env.HODOR_DB, { botId: BOT_ID, userId, threadId: 880, title: "Zoe" });
    await env.HODOR_DB.prepare(
      "INSERT INTO processed_updates (bot_id, update_id, status, attempts, created_at) VALUES (?, 9106, 'processing', 0, ?)",
    )
      .bind(BOT_ID, new Date(Date.now() - 61_000).toISOString())
      .run();

    // 重推：过期接管（attempts 0→1 < MAX → owned）→ 入站复用既有映射 → 重发。
    // 阶段 3 全链差异：预置行的 pinned_msg_id 为 null → 本次接管补发置顶信息
    //（1 次 sendMessage + 1 次 pinChatMessage）；用户为已存在、非 start → 不补欢迎
    const res = await postWebhook(inboundUpdate(9106, userId));
    expect(res.status).toBe(200);

    // 窗口兑现：本次重推**重发一次**中继 sendMessage（投递 #1 的送达是预置前提，
    // 不经过本桩）；createForumTopic 不被调用（topic 复用）
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("pinChatMessage")).toBe(1);
    const relay = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).text === "hello support");
    expect(relay).toHaveLength(1);
    expect(relay[0].body).toMatchObject({ message_thread_id: 880 });
    // 接管确实发生（新插入会是 attempts=0，此处 1 = 0+1 接管），成功后落 processed
    expect(await readProcessed(9106)).toEqual({ status: "processed", attempts: 1 });
  });

  it("媒体端到端（入站 photo，已验证用户）：全链走通——建档 + 建 topic + 置顶 + sendPhoto(file_id+caption+thread) + 账本", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 890 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
    stub.always("sendPhoto", { status: 200, json: { ok: true, result: { message_id: 2 } } });

    await seedVerified(7310);
    const res = await postWebhook({
      update_id: 9110,
      message: {
        message_id: 30,
        from: { id: 7310, first_name: "MediaIn", username: "media_in" },
        chat: { id: 7310, type: "private" },
        photo: [
          { file_id: "e2e_small", file_unique_id: "u1", width: 320, height: 240 },
          { file_id: "e2e_big", file_unique_id: "u2", width: 1280, height: 960 },
        ],
        caption: "端到端配图",
        date: 1700000000,
      },
    });
    expect(res.status).toBe(200);
    expect(await readProcessed(9110)).toEqual({ status: "processed", attempts: 0 });

    // per-type send 按 file_id 直传（最大尺寸），caption 透传，落 topic
    expect(stub.countOf("sendPhoto")).toBe(1);
    expect(stub.callsOf("sendPhoto")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      photo: "e2e_big",
      caption: "端到端配图",
      message_thread_id: 890,
    });
    // 已验证用户首条媒体同权：置顶 + 账本 content_type=photo（无欢迎语——首联包专属）
    expect(stub.countOf("pinChatMessage")).toBe(1);
    const toUser = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7310);
    expect(toUser).toHaveLength(0);
    const ledger = await env.HODOR_DB.prepare(
      "SELECT direction, group_msg_id, private_msg_id, content_type FROM messages WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7310)
      .first<{ direction: string; group_msg_id: number; private_msg_id: number; content_type: string }>();
    expect(ledger).toEqual({ direction: "in", group_msg_id: 2, private_msg_id: 30, content_type: "photo" });
  });

  it("媒体端到端（出站 sticker）：管理员 topic 内发言 → sendSticker 到用户私聊 + 账本 out 行", async () => {
    stub.always("sendSticker", { status: 200, json: { ok: true, result: { message_id: 3 } } });
    const userId = 7311;
    await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: "MediaOut" });
    await insertTopic(env.HODOR_DB, { botId: BOT_ID, userId, threadId: 891, title: "MediaOut" });

    const res = await postWebhook({
      update_id: 9111,
      message: {
        message_id: 31,
        from: { id: ADMIN_ID, first_name: "Admin" },
        chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
        message_thread_id: 891,
        sticker: { file_id: "e2e_stk" },
        date: 1700000000,
      },
    });
    expect(res.status).toBe(200);
    expect(await readProcessed(9111)).toEqual({ status: "processed", attempts: 0 });

    // 私聊不带 thread；精确键集
    expect(stub.countOf("sendSticker")).toBe(1);
    expect(stub.callsOf("sendSticker")[0].body).toEqual({ chat_id: userId, sticker: "e2e_stk" });
    const ledger = await env.HODOR_DB.prepare(
      "SELECT direction, group_msg_id, private_msg_id, content_type FROM messages WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, userId)
      .first<{ direction: string; group_msg_id: number; private_msg_id: number; content_type: string }>();
    expect(ledger).toEqual({ direction: "out", group_msg_id: 31, private_msg_id: 3, content_type: "sticker" });
  });
});

/** 私聊题面按钮回调 update（message_id 即题面消息，data 形如 "v:5"） */
function callbackUpdate(
  updateId: number,
  userId: number,
  msgId: number,
  data: string,
): Record<string, unknown> {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: userId, first_name: "Zoe" },
      message: { message_id: msgId, chat: { id: userId, type: "private" } },
      data,
    },
  };
}

describe("POST /webhook: callback_query 端到端（T27 答题）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("答对全链：首条消息出题（读库取正确答案）→ callback 200 + verified + 题面改通过提示 → 下一条消息建 topic + 置顶 + 中继 + 账本", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 9 } } });
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 810 } },
    });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
    const userId = 7320;

    // ① 新用户首条消息：首联包（欢迎 + 验证题），题面消息 ID = 桩固定 9
    const first = await postWebhook(inboundUpdate(9120, userId));
    expect(first.status).toBe(200);
    expect(await readProcessed(9120)).toEqual({ status: "processed", attempts: 0 });
    const pending = await env.HODOR_DB.prepare(
      "SELECT verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, userId)
      .first<{ verify_answer: number; verify_msg_id: number }>();
    expect(pending!.verify_msg_id).toBe(9);

    // ② 答对按钮（正确答案读库——按钮载荷里没有任何「哪个是对的」信息）
    const answered = await postWebhook(callbackUpdate(9121, userId, 9, `v:${pending!.verify_answer}`));
    expect(answered.status).toBe(200);
    expect(await readProcessed(9121)).toEqual({ status: "processed", attempts: 0 });
    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-9121",
      text: VERIFY_PASSED_TOAST,
    });
    // 题面原位改通过提示（无 topic → 无置顶刷新 edit）
    expect(stub.countOf("editMessageText")).toBe(1);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: userId,
      message_id: 9,
      text: VERIFY_PASSED_TEXT,
    });
    const verified = await env.HODOR_DB.prepare(
      "SELECT is_verified, verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, userId)
      .first<{ is_verified: number; verify_answer: number | null; verify_msg_id: number | null }>();
    expect(verified).toEqual({ is_verified: 1, verify_answer: null, verify_msg_id: null });

    // ③ 通过验证后的新消息：建 topic + 置顶 + 中继 + 账本（被丢弃的 ① 不回溯）
    const relayText = "答题后的第一条";
    const second = await postWebhook({
      update_id: 9122,
      message: {
        message_id: 11,
        from: { id: userId, first_name: "Zoe", username: "zoe_hd" },
        chat: { id: userId, type: "private" },
        text: relayText,
        date: 1700000000,
      },
    });
    expect(second.status).toBe(200);
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("pinChatMessage")).toBe(1);
    const relay = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).text === relayText);
    expect(relay).toHaveLength(1);
    expect(relay[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: relayText,
      message_thread_id: 810,
    });
    const ledger = await env.HODOR_DB.prepare(
      "SELECT direction, private_msg_id, content_type FROM messages WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, userId)
      .first<{ direction: string; private_msg_id: number; content_type: string }>();
    expect(ledger).toEqual({ direction: "in", private_msg_id: 11, content_type: "text" });
  });

  it("畸形 callback（data 非 v:<数字>）→ 200 毒丸吞，零 API 调用、零状态变更", async () => {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7321, first_name: "Zoe" });
    await setPendingVerification(env.HODOR_DB, BOT_ID, 7321, { answer: 5, msgId: 40 });

    const res = await postWebhook(callbackUpdate(9123, 7321, 40, "junk"));
    expect(res.status).toBe(200);
    expect(await readProcessed(9123)).toEqual({ status: "processed", attempts: 0 });
    expect(stub.countOf("answerCallbackQuery")).toBe(0);
    expect(stub.countOf("editMessageText")).toBe(0);
    const row = await env.HODOR_DB.prepare(
      "SELECT is_verified, verify_answer FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7321)
      .first<{ is_verified: number; verify_answer: number }>();
    expect(row).toEqual({ is_verified: 0, verify_answer: 5 });
  });

  it("群内 / 缺 message 的 callback → classify ignore：200 安全忽略，零出站", async () => {
    const groupCallback = {
      update_id: 9124,
      callback_query: {
        id: "cb-9124",
        from: { id: 7321, first_name: "Zoe" },
        message: { message_id: 41, chat: { id: SUPPORT_CHAT_ID, type: "supergroup" } },
        data: "v:5",
      },
    };
    const res = await postWebhook(groupCallback);
    expect(res.status).toBe(200);
    expect(await readProcessed(9124)).toEqual({ status: "processed", attempts: 0 });
    expect(stub.countOf("answerCallbackQuery")).toBe(0);
  });

  it("旧题 / 他人 callback（verify_msg_id 不匹配）→ 失效 toast + 200，零状态变更（不能代答、不能绕过频控）", async () => {
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7322, first_name: "Zoe" });
    await setPendingVerification(env.HODOR_DB, BOT_ID, 7322, { answer: 5, msgId: 42 });

    // 用户点的是更早的题面消息 30（库内 pending 为 42）——即便值「正确」也失效
    const res = await postWebhook(callbackUpdate(9125, 7322, 30, "v:5"));
    expect(res.status).toBe(200);
    expect(await readProcessed(9125)).toEqual({ status: "processed", attempts: 0 });
    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-9125",
      text: VERIFY_EXPIRED_NOTICE,
    });
    expect(stub.countOf("editMessageText")).toBe(0);
    const row = await env.HODOR_DB.prepare(
      "SELECT is_verified, verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7322)
      .first<{ is_verified: number; verify_answer: number; verify_msg_id: number }>();
    expect(row).toEqual({ is_verified: 0, verify_answer: 5, verify_msg_id: 42 });
  });
});

describe("POST /webhook: T18 429 有界重试（验收收口）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  /** 模拟 60s 过期接管窗口流逝（STALE_CLAIM_MS）：倒填认领时间 */
  const backdateClaim = (updateId: number) =>
    env.HODOR_DB.prepare(
      "UPDATE processed_updates SET created_at = ? WHERE bot_id = ? AND update_id = ?",
    )
      .bind(new Date(Date.now() - 61_000).toISOString(), BOT_ID, updateId)
      .run();

  it("持续 429（retry_after=1）→ 每轮投递恰 2 次调用（原地重试恰一次）→ 过期接管 attempts 递增 → MAX_ATTEMPTS 毒丸：failed + 200，零新调用、零账本", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 860 } },
    });
    // sendMessage 恒 429 且 retry_after=1（≤ 3s 预算）：原地 sleep 重试恰一次，
    // 仍 429 → retryable → 抛 → webhook 500 → Telegram 稍后重推
    stub.always("sendMessage", {
      status: 429,
      json: {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 1",
        parameters: { retry_after: 1 },
      },
    });

    const userId = 7330;
    await seedVerified(userId);
    const maxAttempts = parseMaxAttempts(env);

    // 新插入 attempts=0 起逐轮过期接管：0 → 1 → … → maxAttempts-1 全部失败 500
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await postWebhook(inboundUpdate(9130, userId));
      expect(res.status).toBe(500);
      expect(await readProcessed(9130)).toEqual({ status: "processing", attempts: attempt });
      // 每轮失败投递恰 2 次 sendMessage fetch：首试 429 → sleep 1s → 复试 429
      expect(stub.countOf("sendMessage")).toBe(2 * (attempt + 1));
      await backdateClaim(9130);
    }

    // 下一轮接管 attempts = maxAttempts → 毒丸跳过：markFailed + 200，零新调用
    const callsBeforePoison = stub.countOf("sendMessage");
    const poison = await postWebhook(inboundUpdate(9130, userId));
    expect(poison.status).toBe(200);
    expect(await readProcessed(9130)).toEqual({ status: "failed", attempts: maxAttempts });
    expect(stub.countOf("sendMessage")).toBe(callsBeforePoison);

    // failed 后 Telegram 再重推 → duplicate 直接 200，零新调用（整链有界收敛）
    const replay = await postWebhook(inboundUpdate(9130, userId));
    expect(replay.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(callsBeforePoison);
    // 中继从未成功 → 零账本行
    const ledger = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, userId)
      .first<{ n: number }>();
    expect(ledger!.n).toBe(0);
  }, 20_000);

  it("429 retry_after=5（> 3s 预算）→ 不做原地等待：恰 1 次 API 调用即 retryable → webhook 500，行保持 processing(attempts=0)", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 861 } },
    });
    stub.always("sendMessage", {
      status: 429,
      json: {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      },
    });

    const userId = 7331;
    await seedVerified(userId);

    const res = await postWebhook(inboundUpdate(9131, userId));
    expect(res.status).toBe(500);
    // 恰 1 次调用：等待超预算绝不 sleep（整链每 update 至多等待 3s 的保证点）
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(await readProcessed(9131)).toEqual({ status: "processing", attempts: 0 });
  });
});
