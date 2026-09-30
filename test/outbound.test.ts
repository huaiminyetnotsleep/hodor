/**
 * 出站管线集成（T21，design.md「出站管线」逐字执行）：
 * 管理员在映射 topic 发言 → copyMessage 到用户私聊（不带 thread）；
 * 非管理员 / 未映射 thread / closed 行 / 非文本 → 一律静默完成零中继。
 * ADMIN_IDS = "111111111,222222222"（vitest.config.ts）。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleOutbound } from "../src/pipeline/outbound";
import type { TelegramMessageRef } from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890;
const ADMIN_ID = 111111111;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

/** 客服群 topic 内的 message 构造 */
function supportThreadMessage(
  fromId: number,
  threadId: number,
  text: string | undefined = "回复",
  messageId = 60,
): TelegramMessageRef {
  return {
    message_id: messageId,
    from: { id: fromId, first_name: "Admin" },
    chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
    text,
    message_thread_id: threadId,
  };
}

/** 直接播种一条映射行（绕过入站管线，聚焦出站逻辑） */
async function seedTopic(userId: number, threadId: number, status = "open"): Promise<void> {
  await env.HODOR_DB.prepare(
    "INSERT INTO topics (bot_id, user_id, thread_id, title, status) VALUES (?, ?, ?, 'seed', ?)",
  )
    .bind(BOT_ID, userId, threadId, status)
    .run();
}

describe("outbound", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("管理员在映射 topic 发言 → copyMessage 到用户私聊，且不带 message_thread_id", async () => {
    stub.always("copyMessage", { status: 200, json: { ok: true, result: { message_id: 900 } } });
    await seedTopic(7201, 600);

    await handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 600, "请稍等", 61));

    expect(stub.countOf("copyMessage")).toBe(1);
    expect(stub.callsOf("copyMessage")[0].body).toEqual({
      from_chat_id: SUPPORT_CHAT_ID,
      from_message_id: 61,
      chat_id: 7201,
    });
  });

  it("非管理员发言 → 静默完成，零中继", async () => {
    stub.always("copyMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    await seedTopic(7202, 601);

    await handleOutbound(env, BOT_ID, supportThreadMessage(999999999, 601));

    expect(stub.countOf("copyMessage")).toBe(0);
  });

  it("未映射的 thread → 静默完成（「找不到对应用户」提示是 T26 / 阶段 3）", async () => {
    stub.always("copyMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 699));

    expect(stub.countOf("copyMessage")).toBe(0);
  });

  it("closed 行的 thread → 视同未绑定，静默完成", async () => {
    stub.always("copyMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    await seedTopic(7203, 602, "closed");

    await handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 602));

    expect(stub.countOf("copyMessage")).toBe(0);
  });

  it("非文本（管理员 / 已映射 thread）→ 静默完成零中继", async () => {
    stub.always("copyMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    await seedTopic(7204, 603);

    // 真实 photo 消息没有 text 字段（避免构造器默认参数把 undefined 变 "回复"）
    const photo = {
      message_id: 62,
      from: { id: ADMIN_ID, first_name: "Admin" },
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: 603,
      photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
    } as unknown as TelegramMessageRef;
    await handleOutbound(env, BOT_ID, photo);

    expect(stub.countOf("copyMessage")).toBe(0);
  });

  it("copyMessage retryable（网络错误）→ 抛出（→ webhook 500 重推）", async () => {
    stub.always("copyMessage", { throwError: true });
    await seedTopic(7205, 604);

    await expect(
      handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 604)),
    ).rejects.toThrow(/copyMessage/);
  });

  it("copyMessage permanent（403 bot 被拉黑）→ 静默完成不抛", async () => {
    stub.always("copyMessage", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    });
    await seedTopic(7206, 605);

    await expect(
      handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 605)),
    ).resolves.toBeUndefined();
    expect(stub.countOf("copyMessage")).toBe(1);
  });
});
