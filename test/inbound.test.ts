/**
 * 入站管线集成（T19–T25，design.md「入站管线」canonical order 逐字执行）：
 * 首条消息（文本/媒体）建档 + 建 topic + 置顶（恰一条）+ 欢迎 + 账本全链、
 * 复用不重建、closed 重开不重发置顶、昵称变更 editMessageText 刷新、
 * /start 频控（60s 窗口欢迎恰 1 次、topic 不新建）与 /start 短路
 * （入口命令：不中继、不写账本——2026-09-30 真机验收修正）、
 * 支持集之外先于一切副作用静默完成、
 * 失败语义（置顶/欢迎 retryable 抛出且中继不重复；中继 permanent 不写账本）、
 * 并发首联竞态败方清理（删新 thread、用胜方行）。
 *
 * 每个用例独立 userId（文件内 DB 共享）；出站 Telegram 调用全部经
 * telegramFetchStub 拦截（含异步响应器：竞态用例需要在请求中途写 D1），无真实网络。
 *
 * 阶段 3 调整说明：阶段 2 的「非文本静默」用例改用 video_note（photo 及
 * audio 已属支持集，会真实中继；audio 于 2026-09-30 纳入）——原断言意图
 * （支持集之外零副作用）不变；
 * 各阶段 2 用例的 sendMessage 计数按新全链（置顶信息 + 欢迎语 + 中继）更新，
 * 中继本身「恰一次且带 thread」的原始断言意图全部保留。
 * 真机验收修正（2026-09-30）：/start 不再中继进 topic / 不写账本，「start 照常
 * 中继」相关断言全部翻转（意图：topic 不被 start 刷屏，欢迎 / topic / 置顶不变）。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WELCOME_TEXT, formatPinnedInfo } from "../src/copy";
import { handleInbound } from "../src/pipeline/inbound";
import type { TelegramMessageRef } from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import { stubTelegramFetch, type TelegramFetchStub, type StubbedCall } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890; // vitest.config.ts 注入的 SUPPORT_CHAT_ID

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

/** 私聊文本 message 构造（text 显式传 undefined 即非文本） */
function privateMessage(
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  text: string | undefined = "你好",
  messageId = 10,
): TelegramMessageRef {
  return { message_id: messageId, from, chat: { id: from.id, type: "private" }, text };
}

/** 私聊媒体 message 构造（content 直接展开——真实媒体消息没有 text 字段） */
function privateContentMessage(
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  content: Record<string, unknown>,
  messageId: number,
): TelegramMessageRef {
  return {
    message_id: messageId,
    from,
    chat: { id: from.id, type: "private" },
    ...content,
  } as TelegramMessageRef;
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
  pinned_msg_id: number | null;
}
interface MessageRow {
  direction: string;
  group_msg_id: number;
  private_msg_id: number;
  content_type: string;
  thread_id: number;
  user_id: number;
}

const readUser = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT first_name, last_name, username, status, first_seen_at, last_seen_at FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<UserRow>();

const readTopic = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT thread_id, title, status, closed_at, pinned_msg_id FROM topics WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<TopicRow>();

const readMessages = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT direction, group_msg_id, private_msg_id, content_type, thread_id, user_id FROM messages WHERE bot_id = ? AND user_id = ? ORDER BY id",
  )
    .bind(BOT_ID, userId)
    .all<MessageRow>()
    .then((r) => r.results);

/** 某用户私聊收到的欢迎语调用（chat_id = 用户 ID 且 text 匹配；默认比对内置文案） */
function welcomeCalls(
  stub: TelegramFetchStub,
  userId: number,
  text: string = DEFAULT_WELCOME_TEXT,
): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === userId && body.text === text;
  });
}

/** 落进客服群 topic 的中继调用（chat_id = 客服群 且 text 匹配） */
function relayCalls(stub: TelegramFetchStub, text: string): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === SUPPORT_CHAT_ID && body.text === text;
  });
}

/** 每个用例的默认桩：置顶 / 编辑调用默认成功（与用例主旨无关时不逐个注册） */
function defaultPinStubs(stub: TelegramFetchStub): void {
  stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
  stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 1 } } });
}

describe("inbound: 建档、topic 生命周期与全链（置顶 / 欢迎语 / 账本）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("首条文本全链：建档 + 建 topic + 置顶（恰一条）+ 欢迎语 + 中继 + 账本，顺序 pin→welcome→relay", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 100 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 500 } } });

    await handleInbound(
      env,
      BOT_ID,
      privateMessage({ id: 7101, first_name: "Alice", last_name: "L", username: "alice_hd" }),
    );

    // users 行：昵称缓存 + active + 双时间戳
    const user = await readUser(7101);
    expect(user).toMatchObject({
      first_name: "Alice",
      last_name: "L",
      username: "alice_hd",
      status: "active",
    });
    expect(user!.first_seen_at).not.toBeNull();
    // topics 行：thread 100、title 取 first_name、open、置顶消息已落库
    expect(await readTopic(7101)).toEqual({
      thread_id: 100,
      title: "Alice",
      status: "open",
      closed_at: null,
      pinned_msg_id: 500,
    });
    expect(stub.countOf("createForumTopic")).toBe(1);
    // sendMessage 全链恰 3 次，顺序即 canonical order：置顶信息 → 欢迎语 → 中继
    expect(stub.countOf("sendMessage")).toBe(3);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatPinnedInfo({
        id: 7101,
        first_name: "Alice",
        last_name: "L",
        username: "alice_hd",
        firstSeenAt: user!.first_seen_at,
      }),
      message_thread_id: 100,
    });
    expect(stub.callsOf("sendMessage")[1].body).toEqual({ chat_id: 7101, text: DEFAULT_WELCOME_TEXT });
    expect(stub.callsOf("sendMessage")[2].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: "你好",
      message_thread_id: 100,
    });
    // 置顶恰一次：pinChatMessage 带静默标记
    expect(stub.countOf("pinChatMessage")).toBe(1);
    expect(stub.callsOf("pinChatMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 500,
      disable_notification: true,
    });
    expect(stub.countOf("editMessageText")).toBe(0);
    // 账本（T25）：in 行双 ID + content_type 逐项断言；置顶/欢迎不入账本
    const messages = await readMessages(7101);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      direction: "in",
      group_msg_id: 500,
      private_msg_id: 10,
      content_type: "text",
      thread_id: 100,
      user_id: 7101,
    });
  });

  it("第二条文本：不重建 topic、欢迎语不重复；昵称变更 → editMessageText 刷新置顶；first_seen_at 不动", async () => {
    stub.on("createForumTopic", () => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 200 } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 501 } } });

    await handleInbound(
      env,
      BOT_ID,
      privateMessage({ id: 7102, first_name: "旧名", username: "old" }, "第一条", 20),
    );
    // 手工倒填 first_seen_at，验证后续 ensureUser 不会覆盖创建侧列
    await env.HODOR_DB.prepare(
      "UPDATE users SET first_seen_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7102)
      .run();

    await handleInbound(
      env,
      BOT_ID,
      privateMessage({ id: 7102, first_name: "新名", username: "new" }, "第二条", 21),
    );

    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("pinChatMessage")).toBe(1); // 置顶不重复
    // 欢迎语只在首条（isNew）发送，第二条普通文本不再发
    expect(welcomeCalls(stub, 7102)).toHaveLength(1);
    // 两条中继都落在同一 thread（区分于置顶信息：按 text 过滤）
    expect(relayCalls(stub, "第一条")).toHaveLength(1);
    expect(relayCalls(stub, "第二条")).toHaveLength(1);
    for (const text of ["第一条", "第二条"]) {
      expect(relayCalls(stub, text)[0].body).toMatchObject({
        chat_id: SUPPORT_CHAT_ID,
        message_thread_id: 200,
      });
    }
    // 昵称变更触发 4b：editMessageText 刷新为最新昵称（firstSeenAt 用库内建档时间）
    expect(stub.countOf("editMessageText")).toBe(1);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 501,
      text: formatPinnedInfo({
        id: 7102,
        first_name: "新名",
        username: "new",
        firstSeenAt: "2020-01-01T00:00:00.000Z",
      }),
    });
    // 昵称缓存已刷新；first_seen_at 保持首行值；last_seen_at 晚于 first_seen_at
    const user = await readUser(7102);
    expect(user).toMatchObject({ first_name: "新名", username: "new" });
    expect(user!.first_seen_at).toBe("2020-01-01T00:00:00.000Z");
    expect(user!.last_seen_at > "2020-01-01T00:00:00.000Z").toBe(true);
    // 账本两行 in（文本），双 ID 与原始 message_id 对应
    const messages = await readMessages(7102);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      direction: "in",
      group_msg_id: 501,
      private_msg_id: 20,
      content_type: "text",
    });
    expect(messages[1]).toMatchObject({
      direction: "in",
      group_msg_id: 501,
      private_msg_id: 21,
      content_type: "text",
    });
  });

  it("closed 行：重开（status=open, closed_at=NULL）并复用原 thread，不重建、**不重发置顶**", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 300 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 502 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7103, first_name: "Carol" }, "第一条", 30));
    await env.HODOR_DB.prepare(
      "UPDATE topics SET status = 'closed', closed_at = '2025-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7103)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7103, first_name: "Carol" }, "又来了", 31));

    expect(await readTopic(7103)).toEqual({
      thread_id: 300,
      title: "Carol",
      status: "open",
      closed_at: null,
      pinned_msg_id: 502, // 重开保留原置顶
    });
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("pinChatMessage")).toBe(1); // 恰一条置顶（不重发）
    expect(relayCalls(stub, "又来了")[0].body).toMatchObject({ message_thread_id: 300 });
    // 欢迎语仍只在首条
    expect(welcomeCalls(stub, 7103)).toHaveLength(1);
  });

  it("title 三级回退：first_name 空白 → @username；两者皆无 → ID_<user_id>", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 400 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7104, username: "bob_hd" }));
    expect((await readTopic(7104))!.title).toBe("@bob_hd");

    await handleInbound(env, BOT_ID, privateMessage({ id: 7105 }));
    expect((await readTopic(7105))!.title).toBe("ID_7105");

    // first_name 全空白同样回退到 @username
    await handleInbound(env, BOT_ID, privateMessage({ id: 7106, first_name: "   ", username: "ws_user" }));
    expect((await readTopic(7106))!.title).toBe("@ws_user");
  });
});

describe("inbound: 媒体入站（T22）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("7 类媒体逐类：对应 sendX 恰一次（thread + file_id + caption，无多余键），首条媒体全链生效", async () => {
    // thread 逐次递增：UNIQUE (bot_id, thread_id) 不允许多用户共用同一 thread
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 700 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 901 } } });
    const mediaSendMethods = ["sendPhoto", "sendVideo", "sendVoice", "sendAudio", "sendDocument", "sendSticker", "sendAnimation"];
    for (const method of mediaSendMethods) {
      stub.always(method, { status: 200, json: { ok: true, result: { message_id: 902 } } });
    }

    const cases = [
      {
        userId: 7115,
        type: "photo",
        // photo 取最大尺寸 file_id；caption 一并透传
        content: {
          photo: [
            { file_id: "p_small", file_unique_id: "u1", width: 320, height: 240 },
            { file_id: "p_big", file_unique_id: "u2", width: 1280, height: 960 },
          ],
          caption: "配图说明",
        },
        method: "sendPhoto",
        wire: { photo: "p_big", caption: "配图说明" },
      },
      {
        userId: 7116,
        type: "video",
        content: { video: { file_id: "vid_1" }, caption: "视频说明" },
        method: "sendVideo",
        wire: { video: "vid_1", caption: "视频说明" },
      },
      {
        userId: 7117,
        type: "voice",
        content: { voice: { file_id: "vce_1" } },
        method: "sendVoice",
        wire: { voice: "vce_1" },
      },
      {
        userId: 7132,
        type: "audio",
        // 音频（音乐文件，2026-09-30 增补）：file_id + caption 透传，title/performer 忽略
        content: { audio: { file_id: "aud_1", title: "歌名", performer: "歌手" }, caption: "一首歌" },
        method: "sendAudio",
        wire: { audio: "aud_1", caption: "一首歌" },
      },
      {
        userId: 7118,
        type: "document",
        content: { document: { file_id: "doc_1" }, caption: "文件说明" },
        method: "sendDocument",
        wire: { document: "doc_1", caption: "文件说明" },
      },
      {
        userId: 7119,
        type: "sticker",
        // sticker 不可能携带 caption：即便畸形地出现也不透传
        content: { sticker: { file_id: "stk_1" }, caption: "不该出现" },
        method: "sendSticker",
        wire: { sticker: "stk_1" },
      },
      {
        userId: 7120,
        type: "animation",
        content: { animation: { file_id: "gif_1" }, caption: "动图" },
        method: "sendAnimation",
        wire: { animation: "gif_1", caption: "动图" },
      },
    ];

    for (const [index, c] of cases.entries()) {
      const threadId = 700 + index;
      await handleInbound(
        env,
        BOT_ID,
        privateContentMessage({ id: c.userId, first_name: `M${c.userId}` }, c.content, 15),
      );

      // 对应 sendX 恰一次，精确键集：chat + thread + file_id(+caption)
      expect(stub.countOf(c.method), `method ${c.method}`).toBe(1);
      expect(stub.callsOf(c.method)[0].body, `method ${c.method}`).toEqual({
        chat_id: SUPPORT_CHAT_ID,
        message_thread_id: threadId,
        ...c.wire,
      });
      // 首条媒体与文本同权：建档 + 建 topic + 置顶 + 欢迎 + 账本全链
      expect(await readUser(c.userId), `user ${c.userId}`).not.toBeNull();
      const topic = await readTopic(c.userId);
      expect(topic!.thread_id).toBe(threadId);
      expect(topic!.pinned_msg_id).toBe(901);
      expect(welcomeCalls(stub, c.userId), `welcome ${c.userId}`).toHaveLength(1);
      expect(stub.countOf("pinChatMessage"), `pin ${c.userId}`).toBe(index + 1);
      const messages = await readMessages(c.userId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        direction: "in",
        group_msg_id: 902,
        private_msg_id: 15,
        content_type: c.type,
        thread_id: threadId,
        user_id: c.userId,
      });
    }
  });
});

describe("inbound: /start 频控（T23）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("60 秒内反复 /start（含 @bot / payload 变体）：欢迎语恰 1 次、topic 恰 1 个；/start 短路——不中继、不写账本，topic 零新增消息", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 710 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7121, first_name: "Start" }, "/start", 1));
    await handleInbound(env, BOT_ID, privateMessage({ id: 7121, first_name: "Start" }, "/start@hodor_bot", 2));
    await handleInbound(env, BOT_ID, privateMessage({ id: 7121, first_name: "Start" }, "/start payload", 3));

    // 欢迎语恰 1 次（频控窗口内）；topic 恰 1 个（start 不新建）
    expect(welcomeCalls(stub, 7121)).toHaveLength(1);
    expect(stub.countOf("createForumTopic")).toBe(1);
    const topics = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM topics WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7121)
      .first<{ n: number }>();
    expect(topics!.n).toBe(1);
    // /start 是入口命令非对话内容：三条 start 全部不中继（2026-09-30 真机验收修正）
    expect(relayCalls(stub, "/start")).toHaveLength(0);
    expect(relayCalls(stub, "/start@hodor_bot")).toHaveLength(0);
    expect(relayCalls(stub, "/start payload")).toHaveLength(0);
    // 不写账本：topic 零新增消息
    expect(await readMessages(7121)).toHaveLength(0);
    // 群内 sendMessage 恰 1 条 = 置顶信息（首条 /start 建 topic 后 topic 里只有置顶）
    const inTopic = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === SUPPORT_CHAT_ID);
    expect(inTopic).toHaveLength(1);
  });

  it("非 start 文本不触发欢迎；窗口过期（倒填 last_notice_at）后 /start 可再触发", async () => {
    // thread 逐次递增且避开其他用例已占号段（文件内 DB 共享，thread 全局唯一）
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 750 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    // 已存在用户：普通文本 / 前缀巧合（/startups）都不再触发欢迎
    await handleInbound(env, BOT_ID, privateMessage({ id: 7122, first_name: "N" }, "普通消息", 5));
    await handleInbound(env, BOT_ID, privateMessage({ id: 7122, first_name: "N" }, "/startups", 6));
    expect(welcomeCalls(stub, 7122)).toHaveLength(1); // 仅首条 isNew 触发
    expect(stub.countOf("createForumTopic")).toBe(1);

    // 已存在用户 60s 后再 start：slot 重新可赢
    await handleInbound(env, BOT_ID, privateMessage({ id: 7123, first_name: "W" }, "普通消息", 7));
    expect(welcomeCalls(stub, 7123)).toHaveLength(1); // isNew 触发
    await env.HODOR_DB.prepare(
      "UPDATE users SET last_notice_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7123)
      .run();
    await handleInbound(env, BOT_ID, privateMessage({ id: 7123, first_name: "W" }, "/start", 8));
    expect(welcomeCalls(stub, 7123)).toHaveLength(2); // 窗口过期后再赢
    expect(stub.countOf("createForumTopic")).toBe(2); // 两个用户各一个 topic，无新建
    expect(relayCalls(stub, "/start")).toHaveLength(0); // start 不中继（普通文本照常）
    expect(relayCalls(stub, "普通消息").length).toBeGreaterThanOrEqual(1);
  });
});

describe("inbound: 阶段边界与 TelegramResult 消费", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("支持集之外（video_note / 空 text）：先于一切副作用静默完成——不建档、不建 topic、零调用", async () => {
    stub.always("createForumTopic", { status: 200, json: { ok: true, result: { message_thread_id: 1 } } });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("sendAudio", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    // audio 已于 2026-09-30 纳入支持集（上方媒体用例覆盖），此处用 video_note
    const videoNote = privateContentMessage(
      { id: 7107, first_name: "MediaGuy" },
      { video_note: { file_id: "vn1", length: 30, duration: 8 } },
      11,
    );
    await handleInbound(env, BOT_ID, videoNote);
    await handleInbound(env, BOT_ID, privateMessage({ id: 7107, first_name: "MediaGuy" }, "", 12));

    expect(await readUser(7107)).toBeNull();
    expect(await readTopic(7107)).toBeNull();
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("sendMessage")).toBe(0);
    expect(stub.countOf("pinChatMessage")).toBe(0);
    expect(await readMessages(7107)).toHaveLength(0);
  });

  it("中继 retryable（HTTP 503）→ 抛出（→ webhook 500 重推）；置顶/欢迎已完成、账本零行、topic 供重推复用", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 500 } },
    });
    // sendMessage 按调用序：[0] 置顶信息 ok、[1] 欢迎语 ok、[2] 中继 503
    stub.on("sendMessage", (i) =>
      i <= 1
        ? { status: 200, json: { ok: true, result: { message_id: 1000 + i } } }
        : { status: 503, json: { ok: false, description: "upstream boom" } },
    );

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7108, first_name: "Dan" })),
    ).rejects.toThrow(/sendMessage/);
    expect(stub.countOf("sendMessage")).toBe(3);
    // 建档与建 topic 已完成：重推时直接复用，不会二次 createForumTopic
    expect((await readTopic(7108))!.thread_id).toBe(500);
    expect((await readTopic(7108))!.pinned_msg_id).toBe(1000);
    // 中继未成功 → 不写账本（T25：只记成功中继）
    expect(await readMessages(7108)).toHaveLength(0);
  });

  it("中继 permanent（HTTP 400 毒丸）→ 静默完成不抛，不写账本", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 501 } },
    });
    stub.on("sendMessage", (i) =>
      i <= 1
        ? { status: 200, json: { ok: true, result: { message_id: 1 } } }
        : {
            status: 400,
            json: { ok: false, error_code: 400, description: "Bad Request: message text is empty" },
          },
    );

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7109, first_name: "Eve" })),
    ).resolves.toBeUndefined();
    expect(stub.countOf("sendMessage")).toBe(3);
    expect(await readMessages(7109)).toHaveLength(0);
  });

  it("createForumTopic permanent（400）→ 静默完成：不落映射行、不欢迎、不中继（消息按已处理丢弃）", async () => {
    stub.always("createForumTopic", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: need administrator rights" },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7111, first_name: "Frank" })),
    ).resolves.toBeUndefined();
    expect(await readTopic(7111)).toBeNull();
    // 连欢迎语也不发：topic 无法建立即整条丢弃（阶段 2 语义不变）
    expect(stub.countOf("sendMessage")).toBe(0);
  });
});

describe("inbound: 置顶与欢迎语的失败语义（顺序保证：中继不重复）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("置顶信息 send retryable → 抛且中继未发生；重推后补置顶 + 中继恰一次（载体用普通文本：/start 已不中继）", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 720 } },
    });
    // 调用序：#1 [0] 置顶信息 503；重推 #2 [1] 置顶信息 / [2] 中继
    stub.on("sendMessage", (i) =>
      i === 0
        ? { status: 503, json: { ok: false, description: "upstream boom" } }
        : { status: 200, json: { ok: true, result: { message_id: 800 } } },
    );

    const message = privateMessage({ id: 7124, first_name: "PinRetry" }, "你好", 40);
    await expect(handleInbound(env, BOT_ID, message)).rejects.toThrow(/sendMessage/);
    expect(stub.countOf("sendMessage")).toBe(1); // 只有置顶信息一次（失败）
    expect(relayCalls(stub, "你好")).toHaveLength(0); // 中继未发生
    expect(welcomeCalls(stub, 7124)).toHaveLength(0); // 失败点在欢迎语之前
    // topic 已建、pinned_msg_id 未落（重推重走 4a 的判定依据）
    expect((await readTopic(7124))!.pinned_msg_id).toBeNull();
    expect(await readMessages(7124)).toHaveLength(0);

    // 重推：补置顶 → 中继恰一次。欢迎语不补发——isNew 已失真且非 start
    //（已接受语义：仅 /start 可对存量用户重触发）
    await expect(handleInbound(env, BOT_ID, message)).resolves.toBeUndefined();
    expect(stub.countOf("createForumTopic")).toBe(1); // 不重建 topic
    expect(stub.countOf("sendMessage")).toBe(3); // 置顶信息(失败) + 置顶信息 + 中继
    expect(stub.countOf("pinChatMessage")).toBe(1);
    expect((await readTopic(7124))!.pinned_msg_id).toBe(800);
    expect(welcomeCalls(stub, 7124)).toHaveLength(0);
    expect(relayCalls(stub, "你好")).toHaveLength(1); // 恰一次，无重复
    expect(await readMessages(7124)).toHaveLength(1);
  });

  it("欢迎语 retryable（/start 载体）→ 抛且未中继；重推 slot 已占不补欢迎，/start 短路零中继零账本", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 721 } },
    });
    // 调用序：#1 [0] 置顶信息 ok、[1] 欢迎语 503；重推 #2 无新调用
    stub.on("sendMessage", (i) =>
      i === 1
        ? { status: 503, json: { ok: false, description: "upstream boom" } }
        : { status: 200, json: { ok: true, result: { message_id: 900 } } },
    );

    const start = privateMessage({ id: 7125, first_name: "WelcomeRetry" }, "/start", 41);
    await expect(handleInbound(env, BOT_ID, start)).rejects.toThrow(/sendMessage/);
    expect(stub.countOf("sendMessage")).toBe(2); // 置顶信息 + 欢迎语（失败）
    expect(relayCalls(stub, "/start")).toHaveLength(0);
    expect((await readTopic(7125))!.pinned_msg_id).toBe(900); // 置顶已完成

    // 重推：置顶已落（跳过 4a）、slot 已被占（isStart 命中但 claim 输 → 不补
    // 欢迎，已接受的丢失语义：宁可丢失不轰炸）、/start 短路 → 零新调用
    await expect(handleInbound(env, BOT_ID, start)).resolves.toBeUndefined();
    expect(stub.countOf("sendMessage")).toBe(2);
    expect(stub.countOf("pinChatMessage")).toBe(1);
    // 欢迎语只有 #1 失败的那一次尝试（桩按调用记录，不计成败），重推不再补发
    expect(welcomeCalls(stub, 7125)).toHaveLength(1);
    expect(relayCalls(stub, "/start")).toHaveLength(0); // 入口命令不中继
    expect(await readMessages(7125)).toHaveLength(0); // 不写账本
  });

  it("置顶信息 send permanent → warn 跳过（不落 pinned_msg_id），欢迎/中继照常；下一条消息补置顶", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 722 } },
    });
    // 调用序：#1 [0..2] 全 400（置顶/欢迎/中继均 permanent）；#2 [3] 置顶信息 / [4] 欢迎跳过 / [5] 中继
    stub.on("sendMessage", (i) =>
      i < 3
        ? { status: 400, json: { ok: false, error_code: 400, description: "Bad Request" } }
        : { status: 200, json: { ok: true, result: { message_id: 950 } } },
    );

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7126, first_name: "PinPerm" }, "第一条", 50)),
    ).resolves.toBeUndefined();
    // 置 permanent 不落 pinned_msg_id（与 pin permanent 的语义区分）
    expect((await readTopic(7126))!.pinned_msg_id).toBeNull();
    expect(stub.countOf("pinChatMessage")).toBe(0);
    expect(await readMessages(7126)).toHaveLength(0); // 中继也 permanent → 无账本

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7126, first_name: "PinPerm" }, "第二条", 51)),
    ).resolves.toBeUndefined();
    // pinned_msg_id 仍 null → 重走 4a 补置顶；欢迎不再尝试（isNew 失真 + 无 start）；
    // #1 里欢迎语已尝试过一次（permanent 被吞），此处计数即全量
    expect(stub.countOf("pinChatMessage")).toBe(1);
    expect((await readTopic(7126))!.pinned_msg_id).toBe(950);
    expect(welcomeCalls(stub, 7126)).toHaveLength(1);
    const messages = await readMessages(7126);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: "in", group_msg_id: 950, private_msg_id: 51 });
  });

  it("pin permanent（403）→ warn，信息消息已在仍落 pinned_msg_id；流程继续（欢迎 + 中继 + 账本）", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 723 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 960 } } });
    stub.always("pinChatMessage", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: not enough rights" },
    });

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7127, first_name: "PinFail" })),
    ).resolves.toBeUndefined();
    expect((await readTopic(7127))!.pinned_msg_id).toBe(960);
    expect(welcomeCalls(stub, 7127)).toHaveLength(1);
    expect(relayCalls(stub, "你好")).toHaveLength(1);
    expect(await readMessages(7127)).toHaveLength(1);
  });

  it("4b 刷新 permanent（403）→ best-effort warn 跳过，不阻断中继与账本", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 724 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 970 } } });
    stub.always("editMessageText", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden" },
    });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7128, first_name: "旧名" }, "第一条", 60));
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7128, first_name: "新名" }, "第二条", 61)),
    ).resolves.toBeUndefined();
    expect(stub.countOf("editMessageText")).toBe(1); // 尝试过刷新
    expect(relayCalls(stub, "第二条")).toHaveLength(1); // 中继照常
    expect(await readMessages(7128)).toHaveLength(2);
  });
});

describe("inbound: 并发首联竞态（败方清理）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
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
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7110, first_name: "Grace" }, "竞态首联", 40));

    // 败方清理：删的是自己刚建的新 thread 999
    expect(stub.countOf("deleteForumTopic")).toBe(1);
    expect(stub.callsOf("deleteForumTopic")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 999,
    });
    // 中继改用胜方行 thread 555；映射表只有一行（无双有效绑定、无孤儿映射）
    expect(relayCalls(stub, "竞态首联")[0].body).toMatchObject({ message_thread_id: 555 });
    expect(await readTopic(7110)).toEqual({
      thread_id: 555,
      title: "胜方",
      status: "open",
      closed_at: null,
      pinned_msg_id: 1, // 胜方行 pinned 为空 → 败方补置顶（4a 判定驱动）
    });
    // 账本落在胜方 thread
    expect((await readMessages(7110))[0]).toMatchObject({
      direction: "in",
      thread_id: 555,
      private_msg_id: 40,
    });
  });
});

describe("inbound: 欢迎语文案可配置（WELCOME_TEXT，验收前增量）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  /** handleInbound 实际读取的最小 env（显式构造，避免本地 .dev.vars 泄漏影响） */
  function envWithWelcome(welcomeText: string): Cloudflare.Env {
    return {
      HODOR_DB: env.HODOR_DB,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      SUPPORT_CHAT_ID: env.SUPPORT_CHAT_ID,
      WELCOME_TEXT: welcomeText,
    } as unknown as Cloudflare.Env;
  }

  it("配置 WELCOME_TEXT → 欢迎语用自定义文案（字面 \\n 解释为换行），频控照常", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 760 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleInbound(
      envWithWelcome("定制欢迎语第一行\\n定制欢迎语第二行"),
      BOT_ID,
      privateMessage({ id: 7130, first_name: "Custom" }, "/start", 90),
    );

    // 欢迎语正文 = 自定义文案，字面 \n 已解释为真实换行
    const welcome = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7130);
    expect(welcome).toHaveLength(1);
    expect(welcome[0].body).toEqual({
      chat_id: 7130,
      text: "定制欢迎语第一行\n定制欢迎语第二行",
    });

    // 频控不动：窗口内再 /start 不重发（也无默认文案混入）
    await handleInbound(
      envWithWelcome("定制欢迎语第一行\\n定制欢迎语第二行"),
      BOT_ID,
      privateMessage({ id: 7130, first_name: "Custom" }, "/start", 91),
    );
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).chat_id === 7130),
    ).toHaveLength(1);
  });

  it("未配置（空串）→ 欢迎语兜底内置默认文案", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 770 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleInbound(
      envWithWelcome(""),
      BOT_ID,
      privateMessage({ id: 7131, first_name: "Default" }),
    );

    // 空串 → null → DEFAULT_WELCOME_TEXT（helper 默认比对内置文案）；
    // 再按精确正文过滤恰一次，排除任何非默认文案混入
    expect(welcomeCalls(stub, 7131)).toHaveLength(1);
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).text === DEFAULT_WELCOME_TEXT),
    ).toHaveLength(1);
  });
});
