/**
 * POST /webhook 路由集成（T15/T16/T17 + 阶段 3 媒体回归）：头鉴权 401 统一、
 * 毒丸 200、bots 未绑定 500、幂等认领全分支（duplicate / in-flight / poison / owned）、
 * inbound 全链路（建档 + 建 topic + 置顶 + 欢迎 + 单次中继 + 账本 + markProcessed）。
 *
 * 经 SELF.fetch 走完整 worker 入口；Telegram 出站全部经 telegramFetchStub 拦截，
 * 未注册响应器的调用直接抛错——测试内绝无真实网络。
 * vitest.config.ts 已显式注入 MAX_ATTEMPTS="3"（.dev.vars 不再泄漏进 worker
 * env）；毒丸用例的上限值仍从 parseMaxAttempts(env) 动态取，与 worker 同源。
 *
 * 阶段 3 调整说明：首条文本 / 重推去重 / 部分成功窗口三个阶段 2 用例的
 * sendMessage 计数按新全链（置顶信息 + 欢迎语 + 中继）更新——「中继恰一次
 * 且带 thread」「不双发」「绝不提前标记」的原始断言意图全部保留。
 */
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseMaxAttempts } from "../src/env";
import { handleWebhook } from "../src/routes/webhook";
import { upsertBot } from "../src/store/bots";
import { ensureUser } from "../src/store/users";
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

  it("合法密钥 + 首条私聊文本 → 200；建档 + 建 topic + 置顶 + 欢迎 + 中继恰一次 + processed", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 800 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });

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

    // 阶段 3 全链恰 3 次 sendMessage：置顶信息 + 欢迎语 + 中继
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("sendMessage")).toBe(3);
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
    // 欢迎语发到用户私聊
    const welcome = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7301);
    expect(welcome).toHaveLength(1);
    // 账本 in 行
    const ledger = await env.HODOR_DB.prepare(
      "SELECT direction, group_msg_id, private_msg_id, content_type FROM messages WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7301)
      .first<{ direction: string; group_msg_id: number; private_msg_id: number; content_type: string }>();
    expect(ledger).toEqual({ direction: "in", group_msg_id: 1, private_msg_id: 10, content_type: "text" });
  });

  it("同一 update_id 重推 → duplicate 200，零新副作用（sendMessage 零新增调用）", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 801 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });

    const first = await postWebhook(inboundUpdate(9102, 7302));
    expect(first.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(3);

    const replay = await postWebhook(inboundUpdate(9102, 7302));
    expect(replay.status).toBe(200);
    // 重放不再触发任何 Telegram 调用
    expect(stub.countOf("sendMessage")).toBe(3);
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
    //（阶段 3 全链中它先于欢迎/中继——失败点更早，不双发语义不变）
    stub.always("sendMessage", { status: 503, json: { ok: false, description: "unavailable" } });

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
    // 且认领已过期(>60s)。stage-2 入站在 sendMessage 之后没有任何可失败点，
    // 故用真实 store 函数预置该状态（ensureUser + insertTopic + 过期 processing 行），
    // 这是该崩溃点最忠实的可达表示——测试固化的正是「绝不提前标记」的代价。
    const userId = 7305;
    await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: "Zoe", username: "zoe_hd" });
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

  it("媒体端到端（入站 photo）：全链走通——建档 + 建 topic + 置顶 + sendPhoto(file_id+caption+thread) + 账本", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 890 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
    stub.always("sendPhoto", { status: 200, json: { ok: true, result: { message_id: 2 } } });

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
    // 首条媒体同权：置顶 + 欢迎 + 账本 content_type=photo
    expect(stub.countOf("pinChatMessage")).toBe(1);
    const welcome = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7310);
    expect(welcome).toHaveLength(1);
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
