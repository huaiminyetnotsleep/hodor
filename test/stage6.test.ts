/**
 * 阶段 6 集成（T38 /deluser + T39 /purgemsg + T40 /wipealldata + 原生删除
 * topic 自愈）：
 *
 * - /deluser：DB 真值先行（清验证 + status=deleted + topics closed）、
 *   closeForumTopic 真关闭、私聊「重新 /start」提示（直发不占 slot）、
 *   确认携带用户 ID；绑定 / 账本 / 备注保留；closeForumTopic permanent →
 *   warn 吞 + 确认注记；无绑定 → T26；closed 行同样可操作。
 * - /purgemsg：账本 + 置顶驱动逐条删除（三态计数不把未删标为已清空）、
 *   账本行清理、信息卡重发 + 重新置顶；部分失败计数反馈；无绑定 → T26；
 *   deleteMessage retryable → 抛交重推。
 * - /wipealldata：第一步警告 + 60s 时间戳键盘；确认回调再次鉴权（非管理员
 *   toast 拒绝零 DB 写）、超时放弃、取消、伪造载荷静默、重复确认幂等；
 *   确认清空 users / topics / messages，settings / processed_updates / bots
 *   保留，群内 topic 不删（零 deleteForumTopic 调用）。
 * - 原生删除自愈：open 行中继 thread-not-found → 绑定回收 + 本条丢弃 +
 *   下一条新建 topic；closed 行 reopenForumTopic topic-gone → 立即建新
 *   topic（本条不丢）；reopen 其他 permanent → 绑定保留丢本条；retryable → 抛。
 *
 * ADMIN_IDS = "111111111,222222222"（vitest.config.ts）；出站经
 * telegramFetchStub 拦截，无真实网络。阶段 6 新增文件。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DELUSER_USER_NOTICE,
  formatDeluserConfirmed,
  formatPurgeConfirmed,
  UNBOUND_TOPIC_NOTICE,
  WIPE_DONE_TEXT,
  WIPE_TOAST_CANCELLED,
  WIPE_TOAST_EXPIRED,
  WIPE_TOAST_NOT_ADMIN,
  WIPE_TOAST_RUNNING,
  WIPE_WARNING_TEXT,
} from "../src/copy";
import { handleOutbound } from "../src/pipeline/outbound";
import { handleInbound } from "../src/pipeline/inbound";
import { handleWipeCallback } from "../src/pipeline/wipe";
import { isMessageGoneError, isTopicGoneError } from "../src/pipeline/errors";
import type {
  TelegramCallbackQueryRef,
  TelegramMessageRef,
} from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import { ensureUser } from "../src/store/users";
import { stubTelegramFetch, type TelegramFetchStub, type StubbedCall } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890;
const ADMIN_ID = 111111111;
/** 非管理员群成员（ADMIN_IDS 之外） */
const MEMBER_ID = 999999999;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

/** 客服群 topic 内的管理员命令 message 构造（fromId 默认管理员） */
function commandMessage(
  text: string,
  threadId: number,
  fromId: number = ADMIN_ID,
  messageId = 70,
): TelegramMessageRef {
  return {
    message_id: messageId,
    from: { id: fromId, first_name: "Admin" },
    chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
    text,
    message_thread_id: threadId,
  };
}

/** 私聊文本 message 构造 */
function privateMessage(
  from: { id: number; first_name?: string },
  text: string,
  messageId = 10,
): TelegramMessageRef {
  return { message_id: messageId, from, chat: { id: from.id, type: "private" }, text };
}

/** 客服群 topic 内的确认按钮回调构造 */
function wipeCallback(
  data: string,
  fromId: number = ADMIN_ID,
  messageId = 500,
): TelegramCallbackQueryRef {
  return {
    id: `cb-${data}:${fromId}:${messageId}`,
    from: { id: fromId, first_name: fromId === ADMIN_ID ? "Admin" : "Member" },
    message: { message_id: messageId, chat: { id: SUPPORT_CHAT_ID, type: "supergroup" } },
    data,
  };
}

/** 播种已验证用户 + open 绑定（含置顶 / 备注可选） */
async function seedBinding(
  userId: number,
  threadId: number,
  options: { status?: string; pinnedMsgId?: number | null; note?: string | null } = {},
): Promise<void> {
  await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: `U${userId}` });
  await env.HODOR_DB.prepare(
    "UPDATE users SET is_verified = 1, verified_at = ? WHERE bot_id = ? AND user_id = ?",
  )
    .bind(new Date().toISOString(), BOT_ID, userId)
    .run();
  await env.HODOR_DB.prepare(
    "INSERT INTO topics (bot_id, user_id, thread_id, title, status, pinned_msg_id, note) VALUES (?, ?, ?, 'seed', ?, ?, ?)",
  )
    .bind(BOT_ID, userId, threadId, options.status ?? "open", options.pinnedMsgId ?? null, options.note ?? null)
    .run();
}

/** 播种账本行（双向） */
async function seedLedgerRow(
  userId: number,
  threadId: number,
  direction: "in" | "out",
  groupMsgId: number,
  privateMsgId: number,
): Promise<void> {
  await env.HODOR_DB.prepare(
    `INSERT INTO messages (bot_id, user_id, thread_id, direction, group_msg_id, private_msg_id, content_type)
     VALUES (?, ?, ?, ?, ?, ?, 'text')`,
  )
    .bind(BOT_ID, userId, threadId, direction, groupMsgId, privateMsgId)
    .run();
}

/** 发到客服群 topic 的 sendMessage（命令回复 / 信息卡） */
function topicSends(stub: TelegramFetchStub, threadId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === SUPPORT_CHAT_ID && body.message_thread_id === threadId;
  });
}

/** 发往用户私聊的 sendMessage（deluser 提示） */
function userDirectCalls(stub: TelegramFetchStub, userId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter(
    (call) => (call.body as Record<string, unknown>).chat_id === userId,
  );
}

const readTopicRow = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT thread_id, status, closed_at, pinned_msg_id, note FROM topics WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<{
      thread_id: number;
      status: string;
      closed_at: string | null;
      pinned_msg_id: number | null;
      note: string | null;
    }>();

const readUserRow = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT status, is_verified, verified_at, verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<{
      status: string;
      is_verified: number;
      verified_at: string | null;
      verify_answer: number | null;
      verify_msg_id: number | null;
    }>();

const countTable = (table: "users" | "topics" | "messages" | "processed_updates") =>
  env.HODOR_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first<{ n: number }>()
    .then((row) => row!.n);

describe("errors: 错误摘要谓词（阶段 6）", () => {
  it("isTopicGoneError：thread-not-found / TOPIC_ID_INVALID 命中；TOPIC_CLOSED 与其他不命中（宁漏判不误判）", () => {
    expect(isTopicGoneError("sendMessage HTTP 400: Bad Request: message thread not found")).toBe(true);
    expect(isTopicGoneError("reopenForumTopic HTTP 400: Bad Request: TOPIC_ID_INVALID")).toBe(true);
    expect(isTopicGoneError("sendMessage HTTP 400: Bad Request: TOPIC_CLOSED")).toBe(false);
    expect(isTopicGoneError("sendMessage HTTP 403: Forbidden")).toBe(false);
    expect(isTopicGoneError(undefined)).toBe(false);
  });

  it("isMessageGoneError：message to delete not found 命中；其他不命中", () => {
    expect(isMessageGoneError("deleteMessage HTTP 400: Bad Request: message to delete not found")).toBe(true);
    expect(isMessageGoneError("deleteMessage HTTP 400: Bad Request: message can't be deleted")).toBe(false);
    expect(isMessageGoneError(undefined)).toBe(false);
  });
});

describe("commands: /deluser（T38）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("closeForumTopic", { status: 200, json: { ok: true, result: true } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => stub.restore());

  it("全链：清验证 + status=deleted + topics closed + TG 关闭 + 私聊提示 + 确认；绑定 / 账本 / 备注保留", async () => {
    await seedBinding(7301, 301, { pinnedMsgId: 900, note: "仅咨询退款" });
    await seedLedgerRow(7301, 301, "in", 801, 11);
    await seedLedgerRow(7301, 301, "out", 802, 12);

    await handleOutbound(env, BOT_ID, commandMessage("/deluser", 301));

    // DB 真值：验证与信任状态清空 + deleted 态
    expect(await readUserRow(7301)).toEqual({
      status: "deleted",
      is_verified: 0,
      verified_at: null,
      verify_answer: null,
      verify_msg_id: null,
    });
    // topics 行 closed（绑定保留 + 备注保留）
    const topic = await readTopicRow(7301);
    expect(topic).toMatchObject({ thread_id: 301, status: "closed", note: "仅咨询退款" });
    expect(topic!.closed_at).not.toBeNull();
    // 账本保留（历史不清）
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7301)
        .first<{ n: number }>(),
    ).toEqual({ n: 2 });
    // TG 侧真关闭（指向本 thread）
    expect(stub.countOf("closeForumTopic")).toBe(1);
    expect(stub.callsOf("closeForumTopic")[0].body).toMatchObject({ message_thread_id: 301 });
    // 私聊提示（直发，不占 slot）
    const direct = userDirectCalls(stub, 7301);
    expect(direct).toHaveLength(1);
    expect(direct[0].body).toMatchObject({ text: DELUSER_USER_NOTICE });
    // topic 确认（携带用户 ID + 重开语义）
    const replies = topicSends(stub, 301);
    expect(replies).toHaveLength(1);
    expect((replies[0].body as Record<string, unknown>).text).toBe(
      formatDeluserConfirmed(7301),
    );
    // 置顶降级 ❌（best-effort——edit 调用存在）
    expect(stub.countOf("editMessageText")).toBe(1);
  });

  it("无绑定 → T26 提示，零状态副作用、零 closeForumTopic", async () => {
    const topicsBefore = await countTable("topics");
    await handleOutbound(env, BOT_ID, commandMessage("/deluser", 399));
    const replies = topicSends(stub, 399);
    expect(replies).toHaveLength(1);
    expect((replies[0].body as Record<string, unknown>).text).toBe(UNBOUND_TOPIC_NOTICE);
    expect(stub.countOf("closeForumTopic")).toBe(0);
    expect(await countTable("topics")).toBe(topicsBefore); // 零状态副作用
  });

  it("closeForumTopic permanent（topic 已被原生删除）→ warn 吞 + 确认注记，DB 照置 closed", async () => {
    await seedBinding(7302, 302);
    stub.always("closeForumTopic", {
      status: 400,
      json: { ok: false, description: "Bad Request: TOPIC_ID_INVALID" },
    });

    await handleOutbound(env, BOT_ID, commandMessage("/deluser", 302));

    expect(await readTopicRow(7302)).toMatchObject({ status: "closed" });
    const reply = topicSends(stub, 302)[0].body as Record<string, unknown>;
    expect(reply.text as string).toContain("话题关闭未成功");
  });

  it("私聊提示 permanent（拉黑）→ warn 吞 + 确认注记，其余链路照常", async () => {
    await seedBinding(7303, 303);
    // 私聊失败、topic 回复成功：按 chat_id 区分响应
    stub.on("sendMessage", (i) => {
      const call = stub.callsOf("sendMessage")[i];
      const body = call.body as Record<string, unknown>;
      return body.chat_id === 7303
        ? { status: 403, json: { ok: false, description: "Forbidden: bot was blocked by the user" } }
        : { status: 200, json: { ok: true, result: { message_id: 1 } } };
    });

    await handleOutbound(env, BOT_ID, commandMessage("/deluser", 303));

    const reply = topicSends(stub, 303)[0].body as Record<string, unknown>;
    expect(reply.text as string).toContain("私聊提示未送达");
    expect(await readTopicRow(7303)).toMatchObject({ status: "closed" });
  });

  it("closed 行同样可操作（重复 /deluser 幂等）", async () => {
    await seedBinding(7304, 304, { status: "closed" });
    await handleOutbound(env, BOT_ID, commandMessage("/deluser", 304));
    expect(await readUserRow(7304)).toMatchObject({ status: "deleted", is_verified: 0 });
    expect(stub.countOf("closeForumTopic")).toBe(1);
  });
});

describe("commands: /purgemsg（T39）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("deleteMessage", { status: 200, json: { ok: true, result: true } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
  });
  afterEach(() => stub.restore());

  it("全链：账本双向 + 置顶逐条删除 → 账本清理 → 信息卡重发 + 重新置顶；三态计数全删形态", async () => {
    await seedBinding(7401, 401, { pinnedMsgId: 601 });
    await seedLedgerRow(7401, 401, "in", 611, 21);
    await seedLedgerRow(7401, 401, "out", 612, 22);
    await seedLedgerRow(7401, 401, "in", 613, 23);

    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 401));

    // 删除列表 = 账本去重 group_msg_id + 置顶（601）= 4 条，逐条调用
    expect(stub.countOf("deleteMessage")).toBe(4);
    const deletedIds = stub.callsOf("deleteMessage").map(
      (call) => (call.body as Record<string, unknown>).message_id,
    );
    expect(deletedIds).toEqual([601, 611, 612, 613]);
    // 账本行清理
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
        .bind(401)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    // 置顶重置：pinned 清空后重发信息卡（新 ID）+ 重新 pin
    expect(await readTopicRow(7401)).toMatchObject({ pinned_msg_id: 1 });
    expect(stub.countOf("pinChatMessage")).toBe(1);
    // 确认三态计数（全删形态 + 信息卡成功重置）
    const reply = topicSends(stub, 401).at(-1)!.body as Record<string, unknown>;
    expect(reply.text).toBe(formatPurgeConfirmed({ deleted: 4, gone: 0, failed: 0, pinnedReset: true }));
  });

  it("部分失败三态：已删 / 已不存在（not found）/ 失败（权限）分别计数，不把未删标为已清空", async () => {
    await seedBinding(7402, 402, { pinnedMsgId: 602 });
    await seedLedgerRow(7402, 402, "in", 621, 31);
    await seedLedgerRow(7402, 402, "out", 622, 32);
    await seedLedgerRow(7402, 402, "in", 623, 33);
    stub.on("deleteMessage", (i) => {
      if (i === 0) return { status: 200, json: { ok: true, result: true } }; // 602 置顶删除成功
      if (i === 1) return { status: 200, json: { ok: true, result: true } }; // 621 删除成功
      if (i === 2) {
        return { status: 400, json: { ok: false, description: "Bad Request: message to delete not found" } };
      }
      return { status: 400, json: { ok: false, description: "Bad Request: message can't be deleted" } };
    });

    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 402));

    const reply = topicSends(stub, 402).at(-1)!.body as Record<string, unknown>;
    expect(reply.text).toBe(formatPurgeConfirmed({ deleted: 2, gone: 1, failed: 1, pinnedReset: true }));
    expect(reply.text as string).toContain("未清空");
    // 账本仍清理（失败条目不再追踪）
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
        .bind(402)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("无绑定 → T26 提示，零删除调用", async () => {
    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 499));
    const replies = topicSends(stub, 499);
    expect(replies).toHaveLength(1);
    expect((replies[0].body as Record<string, unknown>).text).toBe(UNBOUND_TOPIC_NOTICE);
    expect(stub.countOf("deleteMessage")).toBe(0);
  });

  it("deleteMessage retryable → 抛交重推（已删条目在重跑中收敛为 gone 类）", async () => {
    await seedBinding(7403, 403, { pinnedMsgId: 603 });
    await seedLedgerRow(7403, 403, "in", 631, 41);
    await seedLedgerRow(7403, 403, "in", 632, 42);
    stub.on("deleteMessage", (i) =>
      i === 0
        ? { status: 200, json: { ok: true, result: true } } // 603 删除成功
        : i === 1
          ? { status: 500, json: { ok: false, description: "Internal Server Error" } } // 631 retryable
          : { status: 200, json: { ok: true, result: true } },
    );

    await expect(
      handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 403)),
    ).rejects.toThrow("deleteMessage");
    // 中断即未达收尾：账本保留（重推重跑收敛）
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
        .bind(403)
        .first<{ n: number }>(),
    ).toEqual({ n: 2 });
  });

  it("信息卡重发 permanent → 确认注明「未能重新置顶」，不虚报（pinnedReset=false）", async () => {
    await seedBinding(7405, 405, { pinnedMsgId: 605 });
    await seedLedgerRow(7405, 405, "in", 651, 61);
    // 信息卡 send（正文含「用户 ID」行）permanent 失败；确认回复成功
    stub.on("sendMessage", (i) => {
      const call = stub.callsOf("sendMessage")[i];
      const body = call.body as Record<string, unknown>;
      return typeof body.text === "string" && body.text.includes("用户 ID")
        ? { status: 400, json: { ok: false, description: "Bad Request: message thread not found" } }
        : { status: 200, json: { ok: true, result: { message_id: 1 } } };
    });

    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 405));

    const reply = topicSends(stub, 405).at(-1)!.body as Record<string, unknown>;
    expect(reply.text as string).toContain("未能重新置顶");
    expect(reply.text as string).not.toContain("已重新发送并置顶");
    // pinned_msg_id 保持 null——下次消息 4a 自然补
    expect(await readTopicRow(7405)).toMatchObject({ pinned_msg_id: null });
  });

  it("closed 行可操作（治理不依赖 open）", async () => {
    await seedBinding(7404, 404, { status: "closed" });
    await seedLedgerRow(7404, 404, "in", 641, 51);
    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 404));
    expect(stub.countOf("deleteMessage")).toBe(1);
  });
});

describe("commands + wipe 回调：/wipealldata 两步确认（T40）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 500 } } });
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 500 } } });
  });
  afterEach(() => stub.restore());

  it("第一步：警告文案 + 键盘（yes/no 各携带发起时间戳）；零 DB 副作用", async () => {
    const before = await countTable("topics");
    await handleOutbound(env, BOT_ID, commandMessage("/wipealldata", 501));

    const reply = topicSends(stub, 501)[0].body as Record<string, unknown>;
    expect(reply.text).toBe(WIPE_WARNING_TEXT);
    const keyboard = reply.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    const datas = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
    expect(datas).toHaveLength(2);
    const nowEpoch = Math.floor(Date.now() / 1000);
    for (const data of datas) {
      const match = data.match(/^w:(yes|no):(\d{1,12})$/);
      expect(match).not.toBeNull();
      expect(Number(match![2])).toBeGreaterThanOrEqual(nowEpoch - 5);
      expect(Number(match![2])).toBeLessThanOrEqual(nowEpoch + 5);
    }
    expect(await countTable("topics")).toBe(before); // 第一步零数据变更
  });

  it("确认回调（管理员 + 60s 内）：三表清空、settings / processed_updates / bots 保留、群内 topic 不删", async () => {
    await seedBinding(7501, 601, { note: "x" });
    await seedLedgerRow(7501, 601, "in", 701, 81);
    await env.HODOR_DB.prepare(
      "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (?, ?, 'processed')",
    )
      .bind(BOT_ID, 999001)
      .run();
    const epoch = Math.floor(Date.now() / 1000) - 10; // 60s 窗口内

    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`));

    expect(await countTable("users")).toBe(0);
    expect(await countTable("topics")).toBe(0);
    expect(await countTable("messages")).toBe(0);
    // settings（验证开关缺省行也在）、幂等台账、bot 身份保留
    expect(await countTable("processed_updates")).toBe(1);
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM bots").first<{ n: number }>(),
    ).toEqual({ n: 1 });
    // 群内 topic 不自动删除
    expect(stub.countOf("deleteForumTopic")).toBe(0);
    // toast + 完成文案编辑
    const answered = stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>;
    expect(answered.text).toBe(WIPE_TOAST_RUNNING);
    const edited = stub.callsOf("editMessageText")[0].body as Record<string, unknown>;
    expect(edited.text).toBe(WIPE_DONE_TEXT);
  });

  it("非管理员点击确认 → toast 拒绝、零 DB 写", async () => {
    await seedBinding(7502, 602);
    const [usersBefore, topicsBefore] = [await countTable("users"), await countTable("topics")];
    const epoch = Math.floor(Date.now() / 1000);

    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`, MEMBER_ID));

    expect(await countTable("users")).toBe(usersBefore);
    expect(await countTable("topics")).toBe(topicsBefore);
    const answered = stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>;
    expect(answered.text).toBe(WIPE_TOAST_NOT_ADMIN);
    expect(stub.countOf("editMessageText")).toBe(0);
  });

  it("超 60 秒点击确认 → toast 超时放弃、数据保留", async () => {
    await seedBinding(7503, 603);
    const topicsBefore = await countTable("topics");
    const expired = Math.floor(Date.now() / 1000) - 120;

    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${expired}`));

    expect(await countTable("topics")).toBe(topicsBefore);
    const answered = stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>;
    expect(answered.text).toBe(WIPE_TOAST_EXPIRED);
  });

  it("取消 → toast + 原消息编辑回警告文案（键盘移除）、数据保留", async () => {
    await seedBinding(7504, 604);
    const topicsBefore = await countTable("topics");
    const epoch = Math.floor(Date.now() / 1000);

    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:no:${epoch}`));

    expect(await countTable("topics")).toBe(topicsBefore);
    const answered = stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>;
    expect(answered.text).toBe(WIPE_TOAST_CANCELLED);
    const edited = stub.callsOf("editMessageText")[0].body as Record<string, unknown>;
    expect(edited.text).toBe(WIPE_WARNING_TEXT);
    expect(edited.reply_markup).toBeUndefined(); // 键盘移除
  });

  it("伪造 / 畸形载荷（w:yes:abc、x:…、超长数字）→ 静默完成，零 API 零 DB", async () => {
    await seedBinding(7505, 605);
    const topicsBefore = await countTable("topics");
    for (const bad of ["w:yes:abc", "x:yes:123", `w:yes:${"1".repeat(13)}`, "w:maybe:123"]) {
      await handleWipeCallback(env, BOT_ID, wipeCallback(bad));
    }
    expect(stub.countOf("answerCallbackQuery")).toBe(0);
    expect(await countTable("topics")).toBe(topicsBefore);
  });

  it("完成文案 edit retryable → 抛交重推（清库已先完成，重推收敛到幂等）", async () => {
    await seedBinding(7507, 607);
    stub.always("editMessageText", {
      status: 500,
      json: { ok: false, description: "Internal Server Error" },
    });
    const epoch = Math.floor(Date.now() / 1000);

    await expect(
      handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`, ADMIN_ID, 507)),
    ).rejects.toThrow("editMessageText");
    // 三表 DELETE 先于完成文案编辑——数据已清（重推重跑幂等收敛）
    expect(await countTable("topics")).toBe(0);
    expect(await countTable("users")).toBe(0);
  });

  it("重复确认幂等（同载荷二次回调）：表仍空、保留表不误删", async () => {
    await seedBinding(7506, 606);
    const epoch = Math.floor(Date.now() / 1000);
    const processedBefore = await countTable("processed_updates");
    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`, ADMIN_ID, 506));
    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`, ADMIN_ID, 506));

    expect(await countTable("users")).toBe(0);
    // 幂等台账跨重复确认原样保留（含此前用例播种的行）
    expect(await countTable("processed_updates")).toBe(processedBefore);
    expect(stub.countOf("editMessageText")).toBe(2); // 两次编辑均执行（幂等展示面）
  });
});

describe("inbound: 原生删除 topic 自愈（阶段 6 兼容性核心）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("reopenForumTopic", { status: 200, json: { ok: true, result: true } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
  });
  afterEach(() => stub.restore());

  it("open 行中继 thread-not-found → 绑定回收 + 本条丢弃（零账本）；下一条消息新建 topic 续聊", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 910 } },
    });
    await seedBinding(7601, 701, { pinnedMsgId: 1 });
    // 第一条：中继进已删除 thread → permanent topic-gone
    stub.on("sendMessage", (i) => {
      const call = stub.callsOf("sendMessage")[i];
      const body = call.body as Record<string, unknown>;
      return body.message_thread_id === 701
        ? { status: 400, json: { ok: false, description: "Bad Request: message thread not found" } }
        : { status: 200, json: { ok: true, result: { message_id: 2 } } };
    });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7601, first_name: "A" }, "第一条", 91));

    // 绑定回收：行删除（note 随行丢失）；本条按 permanent 丢弃语义零账本
    expect(await readTopicRow(7601)).toBeNull();
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7601)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });

    // 第二条：无行 → 新建 topic（910）→ 中继成功 + 账本
    stub.on("sendMessage", () => ({ status: 200, json: { ok: true, result: { message_id: 3 } } }));
    await handleInbound(env, BOT_ID, privateMessage({ id: 7601, first_name: "A" }, "第二条", 92));

    expect(await readTopicRow(7601)).toMatchObject({ thread_id: 910, status: "open" });
    const relay = stub
      .callsOf("sendMessage")
      .find((call) => (call.body as Record<string, unknown>).text === "第二条");
    expect(relay!.body).toMatchObject({ message_thread_id: 910 });
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7601)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });

  it("其他 permanent（TOPIC_CLOSED）不触发回收——绑定保留，绝不误删可恢复状态", async () => {
    await seedBinding(7602, 702, { pinnedMsgId: 1 });
    stub.on("sendMessage", (i) => {
      const call = stub.callsOf("sendMessage")[i];
      const body = call.body as Record<string, unknown>;
      return body.message_thread_id === 702
        ? { status: 400, json: { ok: false, description: "Bad Request: TOPIC_CLOSED" } }
        : { status: 200, json: { ok: true, result: { message_id: 2 } } };
    });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7602, first_name: "B" }, "m", 93));

    expect(await readTopicRow(7602)).toMatchObject({ thread_id: 702, status: "open" });
  });

  it("closed 行重开遇 topic-gone → 删行 + 立即建新 topic，本条不丢；users.status 复位 active", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 920 } },
    });
    await seedBinding(7603, 703, { status: "closed" });
    await env.HODOR_DB.prepare(
      "UPDATE users SET status = 'deleted' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7603)
      .run();
    stub.always("reopenForumTopic", {
      status: 400,
      json: { ok: false, description: "Bad Request: TOPIC_ID_INVALID" },
    });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7603, first_name: "C" }, "回来了", 94));

    // 旧绑定回收 + 新 topic（920）承载本条（中继 + 账本齐全）
    expect(await readTopicRow(7603)).toMatchObject({ thread_id: 920, status: "open" });
    expect(stub.countOf("reopenForumTopic")).toBe(1);
    expect(stub.countOf("createForumTopic")).toBe(1);
    const relay = stub
      .callsOf("sendMessage")
      .find((call) => (call.body as Record<string, unknown>).text === "回来了");
    expect(relay!.body).toMatchObject({ message_thread_id: 920 });
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7603)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
    expect((await readUserRow(7603))!.status).toBe("active");
  });

  it("closed 行重开：reopenForumTopic ok → 复用原 thread、users.status 复位、置顶不重发", async () => {
    await seedBinding(7604, 704, { status: "closed", pinnedMsgId: 55 });
    await env.HODOR_DB.prepare(
      "UPDATE users SET status = 'deleted' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7604)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7604, first_name: "D" }, "again", 95));

    expect(await readTopicRow(7604)).toMatchObject({ thread_id: 704, status: "open", pinned_msg_id: 55 });
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("pinChatMessage")).toBe(0); // 置顶保留不重发
    expect((await readUserRow(7604))!.status).toBe("active");
  });

  it("closed 行重开遇其他 permanent → 绑定保留、本条丢弃；retryable → 抛交重推", async () => {
    await seedBinding(7605, 705, { status: "closed" });
    stub.always("reopenForumTopic", {
      status: 403,
      json: { ok: false, description: "Forbidden" },
    });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7605, first_name: "E" }, "m1", 96));
    expect(await readTopicRow(7605)).toMatchObject({ thread_id: 705, status: "closed" }); // 行未删
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7605)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 }); // 本条丢弃

    await seedBinding(7606, 706, { status: "closed" });
    stub.always("reopenForumTopic", {
      status: 500,
      json: { ok: false, description: "Internal Server Error" },
    });
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7606, first_name: "F" }, "m2", 97)),
    ).rejects.toThrow("reopenForumTopic");
    // DB 未动（closed 保持，重推原样重入重开分支）
    expect(await readTopicRow(7606)).toMatchObject({ thread_id: 706, status: "closed" });
  });
});
