/**
 * 全用户广播端到端（webhook 入口）：classify=broadcast 分流、
 * General 预览 / 控制消息两条消息、callback `b:` 路由、确认后的同请求内顺序
 * 发送循环、取消 / 过期 / 忙碌 / 重复点击、webhook 重投幂等修复路径、100/300
 * 收件人规模（AC11）。
 *
 * Telegram 出站全部经 telegramFetchStub 拦截（未注册 responder 直接抛错——
 * 绝无真实网络）；顺序与次数全部按 stub 断言。用户 / 映射直接播种
 * （绕过入站管线）；每条用例自行 reset 所需数据（文件级共享 D1）。
 */
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BROADCAST_CANCELLED_TEXT,
  BROADCAST_DRAFT_EXISTS_NOTICE,
  BROADCAST_EMPTY_RECIPIENTS_NOTICE,
  BROADCAST_EXPIRED_TEXT,
  BROADCAST_INTERRUPTED_TEXT,
  BROADCAST_NO_RECIPIENTS_TEXT,
  BROADCAST_NOT_ADMIN_NOTICE,
  BROADCAST_SENDING_TEXT,
  BROADCAST_TOAST_ALREADY_HANDLED,
  BROADCAST_TOAST_BUSY,
  BROADCAST_TOAST_SENDING,
  BROADCAST_TOPIC_REDIRECT,
  BROADCAST_USAGE_NOTICE,
  formatBroadcastDoneText,
  formatBroadcastTooLong,
  formatBroadcastTooManyRecipients,
} from "../src/copy";
import { findBroadcastBySourceUpdate, cancelActiveBroadcasts } from "../src/store/broadcasts";
import { upsertBot } from "../src/store/bots";
import { handleBroadcastCallback } from "../src/pipeline/broadcast";
import type { TelegramCallbackQueryRef } from "../src/pipeline/classify";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET;
const SUPPORT_CHAT_ID = -1001234567890;
const ADMIN_ID = 111111111;
const OTHER_ADMIN_ID = 222222222;
const NON_ADMIN_ID = 333333333;

/** 公告正文（多个用例共用；发起断言按同一组装契约计算期望值） */
const NOTICE_HTML = "<b>📣 维护通知</b>\n\n今晚维护。\n\n<i>— Hodor</i>";

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

let stub: TelegramFetchStub;

beforeEach(() => {
  stub = stubTelegramFetch();
  // 默认注册 getMe（绝大多数用例都要取落款）；失败用例各自覆盖
  stub.always("getMe", {
    json: { ok: true, result: { id: BOT_ID, username: "hodor_bot", first_name: "Hodor" } },
  });
  // sendMessage 按调用次序返回递增消息 ID（预览 → 控制消息 / 逐位发送）
  stub.on("sendMessage", (callIndex) => ({
    json: { ok: true, result: { message_id: 5000 + callIndex } },
  }));
  stub.always("editMessageText", { json: { ok: true, result: { message_id: 1 } } });
  stub.always("answerCallbackQuery", { json: { ok: true, result: true } });
});

afterEach(() => {
  stub.restore();
});

function postWebhook(body: unknown): Promise<Response> {
  return SELF.fetch("https://example.com/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify(body),
  });
}

let updateSeq = 61000;
function nextUpdateId(): number {
  return ++updateSeq;
}

/** 客服群 General 的 /broadcast 文本 update（无 message_thread_id；可显式指定 update_id 供幂等锚点用例） */
function generalUpdate(text: string, fromId = ADMIN_ID, explicitUpdateId?: number): Record<string, unknown> {
  return {
    update_id: explicitUpdateId ?? nextUpdateId(),
    message: {
      message_id: nextUpdateId() % 100000,
      from: { id: fromId, first_name: "Admin" },
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      text,
      date: 1700000000,
    },
  };
}

/** 客服群 topic 内的 /broadcast（带 message_thread_id → outbound 命令管线） */
function topicCommandUpdate(text: string, threadId: number, fromId = ADMIN_ID): Record<string, unknown> {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId() % 100000,
      from: { id: fromId, first_name: "Admin" },
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      text,
      date: 1700000000,
      message_thread_id: threadId,
    },
  };
}

/** 客服群按钮回调 update（广播确认键盘 b:y|n:<id>） */
function broadcastCallbackUpdate(data: string, controlMsgId: number, fromId = ADMIN_ID): Record<string, unknown> {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `cb-${nextUpdateId()}`,
      from: { id: fromId, first_name: "Admin" },
      message: { message_id: controlMsgId, chat: { id: SUPPORT_CHAT_ID, type: "supergroup" } },
      data,
    },
  };
}

/** 清空并播种收件人（users + topics 双行；绕过入站管线） */
async function seedRecipients(userIds: number[]): Promise<void> {
  await env.HODOR_DB.prepare("DELETE FROM topics").run();
  await env.HODOR_DB.prepare("DELETE FROM users").run();
  if (userIds.length === 0) return;
  await env.HODOR_DB.batch([
    ...userIds.map((userId) =>
      env.HODOR_DB.prepare(
        "INSERT INTO users (bot_id, user_id, first_name, is_verified) VALUES (?, ?, ?, 1)",
      ).bind(BOT_ID, userId, `用户${userId}`),
    ),
    ...userIds.map((userId, index) =>
      env.HODOR_DB.prepare(
        "INSERT INTO topics (bot_id, user_id, thread_id, title) VALUES (?, ?, ?, 'seed')",
      ).bind(BOT_ID, userId, 600 + index),
    ),
  ]);
}

async function resetBroadcastRows(): Promise<void> {
  await env.HODOR_DB.prepare("DELETE FROM broadcasts").run();
}

const readRow = (sourceUpdateId: number) =>
  findBroadcastBySourceUpdate(env.HODOR_DB, BOT_ID, sourceUpdateId);

/** 播种一条任意状态行（直写 SQL；控制消息 ID 供 callback 信封匹配） */
async function seedBroadcastRow(
  sourceUpdateId: number,
  status: string,
  options: { controlMsgId?: number; expiresInMs?: number; updatedAgoMs?: number; success?: number; failure?: number } = {},
): Promise<number> {
  const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 5 * 60_000)).toISOString();
  const updatedAt = new Date(Date.now() - (options.updatedAgoMs ?? 0)).toISOString();
  await env.HODOR_DB.prepare(
    `INSERT INTO broadcasts
       (bot_id, source_update_id, initiator_user_id, support_chat_id,
        preview_msg_id, control_msg_id, message_html, status,
        expected_count, success_count, failure_count, expires_at, updated_at)
     VALUES (?, ?, ?, ?, 4999, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      BOT_ID,
      sourceUpdateId,
      ADMIN_ID,
      SUPPORT_CHAT_ID,
      options.controlMsgId ?? 5001,
      NOTICE_HTML,
      status,
      2,
      options.success ?? 0,
      options.failure ?? 0,
      expiresAt,
      updatedAt,
    )
    .run();
  return (await readRow(sourceUpdateId))!.id;
}

const ledgerCount = async () =>
  (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())!.n;

/** 走完「发起」到 pending 的完整流程，返回 { updateId, rowId, controlMsgId } */
async function createPendingBroadcast(recipients: number[]): Promise<{
  updateId: number;
  rowId: number;
  controlMsgId: number;
}> {
  await resetBroadcastRows();
  await seedRecipients(recipients);
  const updateId = nextUpdateId();
  const sentAt = stub.countOf("sendMessage");
  const res = await postWebhook({
    update_id: updateId,
    message: {
      message_id: 3456,
      from: { id: ADMIN_ID, first_name: "Admin" },
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      text: "/broadcast 维护通知\n今晚维护。",
      date: 1700000000,
    },
  });
  expect(res.status).toBe(200);
  const row = await readRow(updateId);
  expect(row?.status).toBe("pending");
  expect(stub.countOf("sendMessage")).toBe(sentAt + 2);
  return { updateId, rowId: row!.id, controlMsgId: row!.control_msg_id! };
}

describe("broadcast: General 分类与发起门槛", () => {
 it("General 普通文本 / 非本命令前缀 → ignore（零调用、零行；不扩大 General 中继范围）", async () => {
    await resetBroadcastRows();
    await seedRecipients([7101]);
    const before = stub.countOf("sendMessage");

    const plain = await postWebhook(generalUpdate("大家好"));
    expect(plain.status).toBe(200);
    const prefix = await postWebhook(generalUpdate("/broadcasts 大家好"));
    expect(prefix.status).toBe(200);

    expect(stub.countOf("sendMessage")).toBe(before);
    expect(await readRow(0)).toBeNull();
    expect((await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n).toBe(0);
  });

 it("非管理员发起 → General 回权限提示，零行、零按钮", async () => {
    await resetBroadcastRows();
    const res = await postWebhook(generalUpdate("/broadcast 标题\n正文", NON_ADMIN_ID));
    expect(res.status).toBe(200);
    expect(stub.countOf("getMe")).toBe(0); // 鉴权先于任何外部调用
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: BROADCAST_NOT_ADMIN_NOTICE,
    });
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });

 it("空标题（裸命令）→ 用法提示；超长 → 拒绝提示（均零行）", async () => {
    await resetBroadcastRows();
    const usage = await postWebhook(generalUpdate("/broadcast"));
    expect(usage.status).toBe(200);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: BROADCAST_USAGE_NOTICE,
    });

    const longBody = "b".repeat(4200);
    const tooLong = await postWebhook(generalUpdate(`/broadcast 标题\n${longBody}`));
    expect(tooLong.status).toBe(200);
    expect(stub.callsOf("sendMessage")[1].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatBroadcastTooLong(4096),
    });
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });

 it("getMe 网络错误（retryable）→ 500 交重推，零行零预览；permanent → 提示后终止", async () => {
    await resetBroadcastRows();
    stub.always("getMe", { throwError: true });
    const retryable = await postWebhook(generalUpdate("/broadcast 标题\n正文"));
    expect(retryable.status).toBe(500);
    expect(await retryable.json()).toEqual({ error: "temporary_failure" });
    expect(stub.countOf("sendMessage")).toBe(0);
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);

    stub.always("getMe", { status: 400, json: { ok: false, description: "Unauthorized" } });
    const permanent = await postWebhook(generalUpdate("/broadcast 标题\n正文"));
    expect(permanent.status).toBe(200);
 // 恰一条提示（getMe 失败文案），无预览
    expect(stub.countOf("sendMessage")).toBe(1);
    expect((stub.callsOf("sendMessage")[0].body as { text: string }).text).toContain(
      "无法获取 Bot 名称",
    );
  });

 it("零收件人 → 只提示不建任务；超 500 上限 → 拒绝不截断", async () => {
    await resetBroadcastRows();
    await seedRecipients([]);
    const empty = await postWebhook(generalUpdate("/broadcast 标题\n正文"));
    expect(empty.status).toBe(200);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: BROADCAST_EMPTY_RECIPIENTS_NOTICE,
    });
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);

    await seedRecipients(Array.from({ length: 501 }, (_, i) => 8000 + i));
    const tooMany = await postWebhook(generalUpdate("/broadcast 标题\n正文"));
    expect(tooMany.status).toBe(200);
    expect(stub.callsOf("sendMessage")[1].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatBroadcastTooManyRecipients(500),
    });
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });
});

describe("broadcast: 预览与控制消息创建", () => {
 it("完整发起：getMe 落款 → HTML 预览 → 回复控制消息（按钮）→ pending 行", async () => {
    const { updateId, rowId } = await createPendingBroadcast([7101, 7102]);

 // 预览：与用户最终收到完全同 text + parse_mode，无键盘、无内部说明
    const preview = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    expect(preview).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: NOTICE_HTML,
      parse_mode: "HTML",
    });
 // 控制消息：回复预览 + 按钮；预计人数 2、有效期 5 分钟
    const control = stub.callsOf("sendMessage")[1].body as Record<string, unknown>;
    expect(control).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: expect.stringContaining("预计收件用户：2 名"),
      reply_parameters: { message_id: 5000 },
      reply_markup: {
        inline_keyboard: [[
          { text: "确认发送", callback_data: `b:y:${rowId}` },
          { text: "取消", callback_data: `b:n:${rowId}` },
        ]],
      },
    });
    expect((control.text as string).includes("5 分钟")).toBe(true);

    const row = await readRow(updateId)!;
    expect(row!.status).toBe("pending");
    expect(row!.initiator_user_id).toBe(ADMIN_ID);
    expect(row!.support_chat_id).toBe(SUPPORT_CHAT_ID);
    expect(row!.preview_msg_id).toBe(5000);
    expect(row!.control_msg_id).toBe(5001);
    expect(row!.message_html).toBe(NOTICE_HTML);
    expect(row!.recipient_ids_json).toBe("[]");
 // 有效期 ≈ 5 分钟（允许多秒执行余量）
    const ttlMs = new Date(row!.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(4 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(5 * 60_000);
  });

 it("已有 pending 草稿 → 新发起被拒（同 Bot 恰一份草稿）；sending 中允许创建草稿", async () => {
    const first = await createPendingBroadcast([7101]);
    const before = stub.countOf("sendMessage");
    const second = await postWebhook(generalUpdate("/broadcast 另一条\n正文"));
    expect(second.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(before + 1);
    expect(stub.callsOf("sendMessage")[before].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: BROADCAST_DRAFT_EXISTS_NOTICE,
    });
 // 原草稿原样保留
    expect((await readRow(first.updateId))!.status).toBe("pending");

 // sending 中：创建放行（确认阶段拦截），新草稿正常 pending
    await env.HODOR_DB.prepare("DELETE FROM broadcasts").run();
    await seedBroadcastRow(98001, "sending");
    const during = await postWebhook(generalUpdate("/broadcast 发送中草稿\n正文"));
    expect(during.status).toBe(200);
    const draft = await env.HODOR_DB
      .prepare("SELECT status FROM broadcasts WHERE bot_id = ? AND status = 'pending'")
      .bind(BOT_ID)
      .first<{ status: string }>();
    expect(draft?.status).toBe("pending");
  });

 it("webhook 重推未完成创建（preparing 无预览）→ 从既有行续做，仍只有一份任务", async () => {
    await resetBroadcastRows();
    await seedRecipients([7101]);
 // 第一次执行停在「行已建、预览未发」（模拟落库前崩溃）
    const updateId = nextUpdateId();
    await env.HODOR_DB.prepare(
      `INSERT INTO broadcasts (bot_id, source_update_id, initiator_user_id, support_chat_id, message_html, expires_at)
       VALUES (?, ?, ?, ?, '<b>维护通知</b>', ?)`,
    )
      .bind(BOT_ID, updateId, ADMIN_ID, SUPPORT_CHAT_ID, new Date(Date.now() + 60_000).toISOString())
      .run();

    const res = await postWebhook(generalUpdate("/broadcast 维护通知\n今晚维护。", ADMIN_ID, updateId));
    expect(res.status).toBe(200);
 // 恰两条 General 消息（预览 + 控制）；行仍只有一行且进入 pending
    expect(stub.countOf("sendMessage")).toBe(2);
    const rows = await env.HODOR_DB.prepare(
      "SELECT id, status, preview_msg_id, control_msg_id FROM broadcasts WHERE bot_id = ?",
    ).bind(BOT_ID).all<{ id: number; status: string; preview_msg_id: number | null; control_msg_id: number | null }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].status).toBe("pending");
    expect(rows.results[0].preview_msg_id).toBe(5000);
  });

 it("Topic 内 /broadcast → 只回跳转提示（带 thread），不建任务、不中继给用户", async () => {
    await resetBroadcastRows();
    await seedRecipients([7101]);
    const res = await postWebhook(topicCommandUpdate("/broadcast 标题\n正文", 600));
    expect(res.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: BROADCAST_TOPIC_REDIRECT,
      message_thread_id: 600,
    });
    expect(stub.countOf("getMe")).toBe(0);
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
    expect(await ledgerCount()).toBe(0);
  });
});

describe("broadcast: 确认回调与同请求内发送", () => {
 it("非发起人管理员点击 → 拒绝 toast，行保持 pending，零发送", async () => {
    const { controlMsgId, rowId } = await createPendingBroadcast([7101, 7102]);
    const sendsBefore = stub.countOf("sendMessage");
    const res = await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId, OTHER_ADMIN_ID));
    expect(res.status).toBe(200);
    const answered = stub.callsOf("answerCallbackQuery")[0].body;
    expect(answered).toEqual({ callback_query_id: expect.any(String), text: "只有发起本次广播的管理员可以确认或取消。" });
    expect((await env.HODOR_DB.prepare("SELECT status FROM broadcasts WHERE id = ?").bind(rowId).first<{ status: string }>())!.status).toBe("pending");
    expect(stub.countOf("sendMessage")).toBe(sendsBefore);
  });

 it("发起人确认时已不在 ADMIN_IDS → 再鉴权拒绝，行仍 pending 且不发送", async () => {
    const { updateId, controlMsgId, rowId } = await createPendingBroadcast([7101]);
    const callbackBody = broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId);
    const callback = callbackBody.callback_query as TelegramCallbackQueryRef;
    const sendsBefore = stub.countOf("sendMessage");

    await handleBroadcastCallback(
      {
        HODOR_DB: env.HODOR_DB,
        TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
        SUPPORT_CHAT_ID: String(SUPPORT_CHAT_ID),
        ADMIN_IDS: String(OTHER_ADMIN_ID), // 发起人已被移出管理员名单
      } as unknown as Cloudflare.Env,
      BOT_ID,
      callback,
    );

    const toast = stub.callsOf("answerCallbackQuery").at(-1)!.body as { text: string };
    expect(toast.text).toBe("该操作仅客服管理员可用。");
    expect((await readRow(updateId))!.status).toBe("pending");
    expect(stub.countOf("sendMessage")).toBe(sendsBefore);
  });

 it("发起人确认 → 顺序逐位私聊发送（HTML、不带 thread）→ 完成统计 → 删行；零账本、users/topics 不变", async () => {
    const { updateId, controlMsgId, rowId } = await createPendingBroadcast([7101, 7102]);
    const sendsBefore = stub.countOf("sendMessage");
    const usersBefore = await env.HODOR_DB.prepare(
      "SELECT user_id, is_banned, is_verified, status FROM users ORDER BY user_id",
    ).all();
    const topicsBefore = await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM topics").first<{ n: number }>();

    const res = await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId));
    expect(res.status).toBe(200);

 // 恰两条私聊发送：冻结名单升序、冻结 HTML + parse_mode、绝不带 thread / 键盘
    const sends = stub.callsOf("sendMessage").slice(sendsBefore);
    expect(sends).toHaveLength(2);
    expect(sends[0].body).toEqual({ chat_id: 7101, text: NOTICE_HTML, parse_mode: "HTML" });
    expect(sends[1].body).toEqual({ chat_id: 7102, text: NOTICE_HTML, parse_mode: "HTML" });

 // 控制消息两段编辑：正在发送… → 完成统计（含成功语义边界说明）
    const edits = stub.callsOf("editMessageText");
    expect(edits).toHaveLength(2);
    expect(edits[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: controlMsgId,
      text: BROADCAST_SENDING_TEXT,
      reply_markup: { inline_keyboard: [] },
    });
    expect(edits[1].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: controlMsgId,
      text: formatBroadcastDoneText(2, 0),
      reply_markup: { inline_keyboard: [] },
    });

 // 行已删除（General 消息是唯一历史）；零账本；users/topics 不变
    expect(await readRow(updateId)).toBeNull();
    expect(await ledgerCount()).toBe(0);
    const usersAfter = await env.HODOR_DB.prepare(
      "SELECT user_id, is_banned, is_verified, status FROM users ORDER BY user_id",
    ).all();
    expect(usersAfter.results).toEqual(usersBefore.results);
    expect((await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM topics").first<{ n: number }>())).toEqual(topicsBefore);
  });

 it("冻结发生在确认时刻：预览后新增的用户按确认时名单纳入（预览人数仅为预计值）", async () => {
 // 预览时仅 1 名（控制消息显示 1）；确认前新增 2 名 → 冻结 = 确认时刻资格名单
    const { controlMsgId, rowId } = await createPendingBroadcast([7101]);
    const controlText = (stub.callsOf("sendMessage")[1].body as { text: string }).text;
    expect(controlText).toContain("预计收件用户：1 名");
    await seedRecipients([7101, 7102, 7103]);
    const sendsBefore = stub.countOf("sendMessage");
    await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId));
    const sends = stub.callsOf("sendMessage").slice(sendsBefore);
    expect(sends.map((call) => (call.body as { chat_id: number }).chat_id)).toEqual([7101, 7102, 7103]);
  });

 it("确认时人数变为 0 → 行取消（未发送），不因人数变化复活", async () => {
    const { controlMsgId, rowId } = await createPendingBroadcast([7101]);
    await seedRecipients([]); // 资格全部消失
    await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId));
    const edit = stub.callsOf("editMessageText")[0].body as { text: string };
    expect(edit.text).toBe(BROADCAST_NO_RECIPIENTS_TEXT);
    expect(stub.countOf("sendMessage")).toBe(2); // 仅创建期的两条 General 消息
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });

 it("取消：终态文案 + 删行 + 零发送；重复点击 → 「已处理」", async () => {
    const { controlMsgId, rowId } = await createPendingBroadcast([7101]);
    await postWebhook(broadcastCallbackUpdate(`b:n:${rowId}`, controlMsgId));
    expect(stub.countOf("sendMessage")).toBe(2);
    const edit = stub.callsOf("editMessageText")[0].body as { text: string };
    expect(edit.text).toBe(BROADCAST_CANCELLED_TEXT);
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);

 // 第二次点击同一按钮（新 update、同载荷）：行已删 → 「已处理或不存在」
    const again = await postWebhook(broadcastCallbackUpdate(`b:n:${rowId}`, controlMsgId));
    expect(again.status).toBe(200);
    const toast = stub.callsOf("answerCallbackQuery").at(-1)!.body as { text: string };
    expect(toast.text).toBe(BROADCAST_TOAST_ALREADY_HANDLED);
    expect(stub.countOf("sendMessage")).toBe(2);
  });

 it("过期预览（惰性清理收敛）→ 已过期文案 + 删行", async () => {
    await resetBroadcastRows();
    await seedRecipients([7101]);
    const rowId = await seedBroadcastRow(98002, "pending", { expiresInMs: -1_000, controlMsgId: 5001 });
    await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, 5001));
    const edit = stub.callsOf("editMessageText")[0].body as { text: string };
    expect(edit.text).toBe(BROADCAST_EXPIRED_TEXT);
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
    expect(stub.countOf("sendMessage")).toBe(0);
  });

 it("下一次广播操作惰性清理过期预览与滞留 sending：更新 General 状态、移除按钮并删旧行", async () => {
    await resetBroadcastRows();
    await seedRecipients([7101]);
    const stalePendingId = await seedBroadcastRow(98010, "pending", {
      controlMsgId: 5010,
      expiresInMs: -1_000,
    });
    const staleSendingId = await seedBroadcastRow(98011, "sending", {
      controlMsgId: 5011,
      updatedAgoMs: 11 * 60_000,
    });

    const res = await postWebhook(generalUpdate("/broadcast 新公告\n正文"));
    expect(res.status).toBe(200);
    const cleanupEdits = stub.callsOf("editMessageText").slice(0, 2);
    expect(cleanupEdits.map((call) => (call.body as { message_id: number; text: string }).message_id)).toEqual([
      5010,
      5011,
    ]);
    expect((cleanupEdits[0].body as { text: string }).text).toBe(BROADCAST_EXPIRED_TEXT);
    expect((cleanupEdits[1].body as { text: string }).text).toBe(BROADCAST_INTERRUPTED_TEXT);
    for (const edit of cleanupEdits) {
      expect(edit.body).toMatchObject({ reply_markup: { inline_keyboard: [] } });
    }
    const oldRows = await env.HODOR_DB.prepare("SELECT id FROM broadcasts WHERE id IN (?, ?)")
      .bind(stalePendingId, staleSendingId)
      .all();
    expect(oldRows.results).toEqual([]);
    const activeDraft = await env.HODOR_DB.prepare(
      "SELECT status FROM broadcasts WHERE bot_id = ? AND status = 'pending'",
    ).bind(BOT_ID).first<{ status: string }>();
    expect(activeDraft?.status).toBe("pending"); // 新广播可继续创建
  });

 it("已有广播发送中 → busy toast，pending 保留至自然过期（R10）", async () => {
    const { updateId, controlMsgId, rowId } = await createPendingBroadcast([7102]);
 // 创建完成后再播种 sending 行（createPendingBroadcast 内部会清空 broadcasts）
    await seedBroadcastRow(98003, "sending", { controlMsgId: 5001 });
    const sendsBefore = stub.countOf("sendMessage");
    await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId));
    const toast = stub.callsOf("answerCallbackQuery").at(-1)!.body as { text: string };
    expect(toast.text).toBe(BROADCAST_TOAST_BUSY);
    expect((await readRow(updateId))!.status).toBe("pending");
    expect(stub.countOf("sendMessage")).toBe(sendsBefore);
    expect(stub.countOf("editMessageText")).toBe(0);
  });

 it("重投重跑见未陈旧 sending → 「正在发送」toast 后直接结束，绝不并发第二份", async () => {
    await resetBroadcastRows();
    const rowId = await seedBroadcastRow(98004, "sending", { controlMsgId: 5001 });
    const res = await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, 5001));
    expect(res.status).toBe(200);
    const toast = stub.callsOf("answerCallbackQuery")[0].body as { text: string };
    expect(toast.text).toBe(BROADCAST_TOAST_SENDING);
    expect(stub.countOf("sendMessage")).toBe(0);
    expect(stub.countOf("editMessageText")).toBe(0);
  });

 it("completed 修复路径：只重做统计编辑与删行，绝不重发公告", async () => {
    await resetBroadcastRows();
    const rowId = await seedBroadcastRow(98005, "completed", { controlMsgId: 5001, success: 5, failure: 2 });
    const res = await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, 5001));
    expect(res.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(0); // 绝不重发
    expect(stub.callsOf("editMessageText")).toHaveLength(1);
    expect((stub.callsOf("editMessageText")[0].body as { text: string }).text).toBe(
      formatBroadcastDoneText(5, 2),
    );
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });

 it("failed（中断）修复路径 → 「中断，结果未知」文案 + 删行", async () => {
    await resetBroadcastRows();
    const rowId = await seedBroadcastRow(98006, "failed", { controlMsgId: 5001 });
    await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, 5001));
    expect((stub.callsOf("editMessageText")[0].body as { text: string }).text).toBe(
      BROADCAST_INTERRUPTED_TEXT,
    );
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
    expect(stub.countOf("sendMessage")).toBe(0);
  });

 it("孤立 / 伪造按钮（行不存在或控制消息不匹配）→ 「已处理或不存在」，零副作用", async () => {
    await resetBroadcastRows();
    await seedRecipients([7101]);
 // 行不存在
    await postWebhook(broadcastCallbackUpdate("b:y:999999", 5001));
 // 行存在但 control_msg_id 不匹配（旧消息上的按钮）
    const rowId = await seedBroadcastRow(98007, "pending", { controlMsgId: 5001 });
    await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, 4123));
    for (const toast of stub.callsOf("answerCallbackQuery")) {
      expect((toast.body as { text: string }).text).toBe(BROADCAST_TOAST_ALREADY_HANDLED);
    }
    expect(stub.countOf("sendMessage")).toBe(0);
    expect(stub.countOf("editMessageText")).toBe(0);
    expect((await readRow(98007))!.status).toBe("pending");
  });

 it("确认时人数超过 500（预览后新增）→ 行取消 + 超上限文案，绝不截断发送", async () => {
    const { controlMsgId, rowId } = await createPendingBroadcast([7101]);
    await seedRecipients(Array.from({ length: 501 }, (_, i) => 8000 + i));
    await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId));
    const edit = stub.callsOf("editMessageText")[0].body as { text: string };
    expect(edit.text).toBe(formatBroadcastTooManyRecipients(500));
    expect(stub.countOf("sendMessage")).toBe(2); // 仅创建期两条 General 消息，零用户发送
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });

 it("外群发起 → ignore（零调用、零行；广播绝不从外群群发）", async () => {
    await resetBroadcastRows();
    const res = await postWebhook({
      update_id: nextUpdateId(),
      message: {
        message_id: 4001,
        from: { id: ADMIN_ID, first_name: "Admin" },
        chat: { id: -1009876543210, type: "supergroup" },
        text: "/broadcast 标题\n正文",
        date: 1700000000,
      },
    });
    expect(res.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(0);
    expect(stub.countOf("getMe")).toBe(0);
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });

 it("完成统计编辑 retryable → 500 交重推；过期接管重跑见 completed → 只重做编辑与删行，绝不重发（AC8/AC10）", async () => {
    const { controlMsgId, rowId } = await createPendingBroadcast([7101]);
 // 「正在发送…」编辑成功；最终统计编辑恰第一次失败（retryable），重投重跑成功
    stub.on("editMessageText", (callIndex) =>
      callIndex === 1
        ? { status: 502, json: { ok: false, description: "Bad Gateway" } }
        : { json: { ok: true, result: { message_id: 1 } } },
    );
    const sendsBefore = stub.countOf("sendMessage");
    const callbackBody = broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId);
    const first = await postWebhook(callbackBody);
    expect(first.status).toBe(500); // 用户已收到（1 次发送），统计编辑失败交重推
    expect(stub.countOf("sendMessage")).toBe(sendsBefore + 1);
    const midRow = await env.HODOR_DB.prepare(
      "SELECT status, success_count, failure_count FROM broadcasts WHERE id = ?",
    ).bind(rowId).first<{ status: string; success_count: number; failure_count: number }>();
    expect(midRow).toEqual({ status: "completed", success_count: 1, failure_count: 0 });

 // Telegram 重推同一 callback update（同 update_id）：倒填认领时间模拟 60s 过期接管
    await env.HODOR_DB.prepare(
      "UPDATE processed_updates SET created_at = ? WHERE bot_id = ? AND update_id = ?",
    )
      .bind(new Date(Date.now() - 61_000).toISOString(), BOT_ID, callbackBody.update_id as number)
      .run();
    const redelivered = await postWebhook(callbackBody);
    expect(redelivered.status).toBe(200);
 // 重跑绝不重发公告：发送次数不变；只重做统计编辑 + 删行
    expect(stub.countOf("sendMessage")).toBe(sendsBefore + 1);
    const lastEdit = stub.callsOf("editMessageText").at(-1)!.body as { text: string };
    expect(lastEdit.text).toBe(formatBroadcastDoneText(1, 0));
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });

 it("清库在一条私聊请求进行中取消广播后，后续收件人不再发送且结果标为未知", async () => {
    const { controlMsgId, rowId } = await createPendingBroadcast([7121, 7122, 7123]);
    const sendsBefore = stub.countOf("sendMessage");
    stub.on("sendMessage", async (callIndex) => {
      if (callIndex === sendsBefore) {
 // 模拟 /wipealldata 在第一条请求已开始时将 sending 原子改为 failed。
 // 当前这一条不可撤回；循环下一位前必须观察到取消并停止。
        await cancelActiveBroadcasts(env.HODOR_DB, BOT_ID);
      }
      return { json: { ok: true, result: { message_id: 7000 + callIndex } } };
    });

    const res = await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId));
    expect(res.status).toBe(200);
    const sends = stub.callsOf("sendMessage").slice(sendsBefore);
    expect(sends.map((call) => (call.body as { chat_id: number }).chat_id)).toEqual([7121]);
    const edits = stub.callsOf("editMessageText");
    expect((edits.at(-1)!.body as { text: string }).text).toBe(BROADCAST_INTERRUPTED_TEXT);
    expect((edits.at(-1)!.body as { reply_markup: unknown }).reply_markup).toEqual({
      inline_keyboard: [],
    });
    expect(await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>()).toMatchObject({
      n: 0,
    });
  });

 it("发送循环三态：ok 计成功；permanent 计失败继续；429 有界重试恰一次；无 retry_after 的 retryable 计失败", async () => {
    const { controlMsgId, rowId } = await createPendingBroadcast([7111, 7112, 7113, 7114]);
 // 创建期已产生 2 次 sendMessage（预览 + 控制）；确认后的发送序列：
 // 7111 ok → 7112 permanent → 7113 429 → 7113 有界重试恰一次（ok）→ 7114 5xx
    const sendsBefore = stub.countOf("sendMessage");
    const callTargets = [7111, 7112, 7113, 7113, 7114];
    stub.on("sendMessage", (callIndex) => {
      if (callIndex < sendsBefore) {
        return { json: { ok: true, result: { message_id: 5000 + callIndex } } };
      }
      const relative = callIndex - sendsBefore;
      const target = callTargets[relative];
      if (target === 7112) {
        return { status: 400, json: { ok: false, description: "Forbidden: bot was blocked by the user" } };
      }
      if (target === 7113 && relative === 2) {
        return {
          status: 429,
          json: { ok: false, description: "Too Many Requests", parameters: { retry_after: 4 } },
        };
      }
      if (target === 7114) {
        return { status: 502, json: { ok: false, description: "Bad Gateway" } };
      }
      return { json: { ok: true, result: { message_id: 6000 + callIndex } } };
    });

    const startedAt = Date.now();
    const res = await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId));
    expect(res.status).toBe(200);

 // 7113 恰两次（初次 + 重试一次，重试在原位紧随其后）；7112/7114 各一次（不循环）
    const sends = stub.callsOf("sendMessage").slice(sendsBefore);
    const targets = sends.map((call) => (call.body as { chat_id: number }).chat_id);
    expect(targets).toEqual([7111, 7112, 7113, 7113, 7114]);
 // 429 重试前有界等待真实发生（retry_after=4s，≤10s 上限内）
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_900);

    const stats = stub.callsOf("editMessageText").at(-1)!.body as { text: string };
    expect(stats.text).toBe(formatBroadcastDoneText(2, 2));
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  }, 30_000);
});

describe("broadcast: 规模（AC11，stub 顺序发送）", () => {
 it("100 收件人：回调请求内顺序发送、计数正确、无真实网络", async () => {
    const recipients = Array.from({ length: 100 }, (_, i) => 9000 + i);
    const { controlMsgId, rowId } = await createPendingBroadcast(recipients);
    const sendsBefore = stub.countOf("sendMessage");
    const res = await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId));
    expect(res.status).toBe(200);
    const sends = stub.callsOf("sendMessage").slice(sendsBefore);
    expect(sends).toHaveLength(100);
    expect(sends.every((call) => (call.body as { parse_mode?: string }).parse_mode === "HTML")).toBe(true);
    expect(sends.map((call) => (call.body as { chat_id: number }).chat_id)).toEqual(recipients);
    const stats = stub.callsOf("editMessageText").at(-1)!.body as { text: string };
    expect(stats.text).toBe(formatBroadcastDoneText(100, 0));
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });

 it("300 收件人：同上（单请求内完成）", async () => {
    const recipients = Array.from({ length: 300 }, (_, i) => 9500 + i);
    const { controlMsgId, rowId } = await createPendingBroadcast(recipients);
    const sendsBefore = stub.countOf("sendMessage");
    const res = await postWebhook(broadcastCallbackUpdate(`b:y:${rowId}`, controlMsgId));
    expect(res.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(sendsBefore + 300);
    const stats = stub.callsOf("editMessageText").at(-1)!.body as { text: string };
    expect(stats.text).toBe(formatBroadcastDoneText(300, 0));
    expect(
      (await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first<{ n: number }>())!.n,
    ).toBe(0);
  });
});
