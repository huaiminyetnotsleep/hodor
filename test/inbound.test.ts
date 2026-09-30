/**
 * 入站管线集成（T19/T20/T21，design.md「入站管线」逐字执行）：
 * 首条文本建档 + 建 topic（createForumTopic 恰一次）、复用不重建、
 * closed 重开（status=open, closed_at=NULL）、title 三级回退、
 * 非文本先于一切副作用静默完成、forwardMessage retryable 抛 / permanent 吞、
 * createForumTopic permanent 吞、并发首联竞态败方清理（删新 thread、用胜方行）。
 *
 * 每个用例独立 userId（文件内 DB 共享）；出站 Telegram 调用全部经
 * telegramFetchStub 拦截（含异步响应器：竞态用例需要在请求中途写 D1），无真实网络。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "../src/pipeline/inbound";
import type { TelegramMessageRef } from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890; // vitest.config.ts 注入的 SUPPORT_CHAT_ID

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

/** 私聊 message 构造（缺省带非空 text；text 显式传 undefined 即非文本） */
function privateMessage(
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  text: string | undefined = "你好",
  messageId = 10,
): TelegramMessageRef {
  return { message_id: messageId, from, chat: { id: from.id, type: "private" }, text };
}

interface UserRow {
  first_name: string;
  last_name: string;
  username: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}
interface TopicRow {
  thread_id: number;
  title: string;
  status: string;
  closed_at: string | null;
}

const readUser = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT first_name, last_name, username, status, first_seen_at, last_seen_at FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<UserRow>();

const readTopic = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT thread_id, title, status, closed_at FROM topics WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<TopicRow>();

describe("inbound: 建档与 topic 生命周期", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("首条文本：建档 + createForumTopic 恰一次 + 映射行 + forwardMessage 带 thread", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 100 } },
    });
    stub.always("forwardMessage", { status: 200, json: { ok: true, result: { message_id: 500 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7101, first_name: "Alice", last_name: "L", username: "alice_hd" }));

    // users 行：昵称缓存 + active + 双时间戳
    expect(await readUser(7101)).toMatchObject({
      first_name: "Alice",
      last_name: "L",
      username: "alice_hd",
      status: "active",
    });
    expect((await readUser(7101))!.first_seen_at).not.toBeNull();
    // topics 行：thread 100、title 取 first_name、open
    expect(await readTopic(7101)).toEqual({ thread_id: 100, title: "Alice", status: "open", closed_at: null });
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("forwardMessage")).toBe(1);
    // 精确键集：forwardMessage 用 message_id（非 from_message_id），带 thread、无 text
    expect(stub.callsOf("forwardMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      from_chat_id: 7101,
      message_id: 10,
      message_thread_id: 100,
    });
  });

  it("第二条文本：不重建 topic，复用同一 thread_id，且昵称缓存刷新 / first_seen_at 不动", async () => {
    stub.on("createForumTopic", () => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 200 } },
    }));
    stub.always("forwardMessage", { status: 200, json: { ok: true, result: { message_id: 501 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7102, first_name: "旧名", username: "old" }, "第一条", 20));
    // 手工倒填 first_seen_at，验证后续 ensureUser 不会覆盖创建侧列
    await env.HODOR_DB.prepare(
      "UPDATE users SET first_seen_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7102)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7102, first_name: "新名", username: "new" }, "第二条", 21));

    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("forwardMessage")).toBe(2);
    // 两次中继都落在同一 thread
    for (const call of stub.callsOf("forwardMessage")) {
      expect(call.body).toMatchObject({ chat_id: SUPPORT_CHAT_ID, message_thread_id: 200 });
    }
    // 昵称缓存已刷新；first_seen_at 保持首行值；last_seen_at 晚于 first_seen_at
    const user = await readUser(7102);
    expect(user).toMatchObject({ first_name: "新名", username: "new" });
    expect(user!.first_seen_at).toBe("2020-01-01T00:00:00.000Z");
    expect(user!.last_seen_at > "2020-01-01T00:00:00.000Z").toBe(true);
  });

  it("closed 行：重开（status=open, closed_at=NULL）并复用原 thread，不重建", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 300 } },
    });
    stub.always("forwardMessage", { status: 200, json: { ok: true, result: { message_id: 502 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7103, first_name: "Carol" }, "第一条", 30));
    await env.HODOR_DB.prepare(
      "UPDATE topics SET status = 'closed', closed_at = '2025-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7103)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7103, first_name: "Carol" }, "又来了", 31));

    expect(await readTopic(7103)).toEqual({ thread_id: 300, title: "Carol", status: "open", closed_at: null });
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.callsOf("forwardMessage")[1].body).toMatchObject({ message_thread_id: 300 });
  });

  it("title 三级回退：first_name 空白 → @username；两者皆无 → ID_<user_id>", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 400 + i } },
    }));
    stub.always("forwardMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7104, username: "bob_hd" }));
    expect((await readTopic(7104))!.title).toBe("@bob_hd");

    await handleInbound(env, BOT_ID, privateMessage({ id: 7105 }));
    expect((await readTopic(7105))!.title).toBe("ID_7105");

    // first_name 全空白同样回退到 @username
    await handleInbound(env, BOT_ID, privateMessage({ id: 7106, first_name: "   ", username: "ws_user" }));
    expect((await readTopic(7106))!.title).toBe("@ws_user");
  });
});

describe("inbound: 阶段边界与 TelegramResult 消费", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("非文本（photo / text 空串）：先于一切副作用静默完成——不建档、不建 topic、不中继", async () => {
    stub.always("createForumTopic", { status: 200, json: { ok: true, result: { message_thread_id: 1 } } });
    stub.always("forwardMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    // 真实 photo 消息没有 text 字段（不能走 privateMessage 的默认参数：
    // 显式传 undefined 仍会触发默认值"你好"）
    const photo = {
      message_id: 10,
      from: { id: 7107, first_name: "PhotoGuy" },
      chat: { id: 7107, type: "private" },
      photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
    } as unknown as TelegramMessageRef;
    await handleInbound(env, BOT_ID, photo);
    await handleInbound(env, BOT_ID, privateMessage({ id: 7107, first_name: "PhotoGuy" }, "", 11));

    expect(await readUser(7107)).toBeNull();
    expect(await readTopic(7107)).toBeNull();
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("forwardMessage")).toBe(0);
  });

  it("forwardMessage retryable（HTTP 500）→ 抛出（→ webhook 500 重推）；topic 已建好供重推复用", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 500 } },
    });
    stub.always("forwardMessage", { status: 500, json: { ok: false, description: "upstream boom" } });

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7108, first_name: "Dan" })),
    ).rejects.toThrow(/forwardMessage/);
    expect(stub.countOf("forwardMessage")).toBe(1);
    // 建档与建 topic 已完成：重推时直接复用，不会二次 createForumTopic
    expect((await readTopic(7108))!.thread_id).toBe(500);
  });

  it("forwardMessage permanent（HTTP 400 毒丸）→ 静默完成不抛（阶段 2：按已处理丢弃）", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 501 } },
    });
    stub.always("forwardMessage", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: message to forward not found" },
    });

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7109, first_name: "Eve" })),
    ).resolves.toBeUndefined();
    expect(stub.countOf("forwardMessage")).toBe(1);
  });

  it("createForumTopic permanent（400）→ 静默完成：不落映射行、不中继（消息按已处理丢弃）", async () => {
    stub.always("createForumTopic", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: need administrator rights" },
    });
    stub.always("forwardMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7111, first_name: "Frank" })),
    ).resolves.toBeUndefined();
    expect(await readTopic(7111)).toBeNull();
    expect(stub.countOf("forwardMessage")).toBe(0);
  });
});

describe("inbound: 并发首联竞态（败方清理）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("createForumTopic 返回前后被并发写入胜方行 → 删自己新建的 thread，改用胜方行中继", async () => {
    // 异步响应器：在本请求「进行中」模拟并发写者抢先落行（thread 555），
    // 然后本方 createForumTopic 才返回新 thread 999 → insertTopic 唯一冲突
    stub.on("createForumTopic", async () => {
      await env.HODOR_DB.prepare(
        "INSERT INTO topics (bot_id, user_id, thread_id, title, created_at) VALUES (?, ?, 555, '胜方', ?)",
      )
        .bind(BOT_ID, 7110, new Date().toISOString())
        .run();
      return { status: 200, json: { ok: true, result: { message_thread_id: 999 } } };
    });
    stub.always("deleteForumTopic", { status: 200, json: { ok: true, result: true } });
    stub.always("forwardMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7110, first_name: "Grace" }, "竞态首联", 40));

    // 败方清理：删的是自己刚建的新 thread 999
    expect(stub.countOf("deleteForumTopic")).toBe(1);
    expect(stub.callsOf("deleteForumTopic")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 999,
    });
    // 中继改用胜方行 thread 555；映射表只有一行（无双有效绑定、无孤儿映射）
    expect(stub.callsOf("forwardMessage")[0].body).toMatchObject({ message_thread_id: 555 });
    expect(await readTopic(7110)).toEqual({ thread_id: 555, title: "胜方", status: "open", closed_at: null });
  });
});
