/**
 * 命令管线集成（T34 /help + T35 /ban /unban，经 handleOutbound 全链入口）：
 * 管理员 `/` 开头文本 → 命令分流——一律回当前 topic（管理员可见）、
 * **零用户侧消息、零 messages 账本、永不中继**；/help 内容（HELP_TEXT 原文）
 * 与 @bot 后缀 / 参数容忍；/ban /unban 状态流转（is_banned 0/1）+ topic 确认
 * （携带目标用户 ID）+ DB 真值先行（确认回复失败不翻转状态）；closed topic
 * 同样可操作（治理不依赖 open——区别于中继的 closed 视同未绑定）；无绑定 →
 * 复用 T26 提示；未知命令 → 引导 /help；非管理员 `/` 命令回「仅管理员可用」
 * 提示（真机验收增量，原静默；非命令文本仍静默）；解禁后恢复
 * 正常门序（未验证用户回到验证门）。
 *
 * ADMIN_IDS = "111111111,222222222"（vitest.config.ts）；出站经
 * telegramFetchStub 拦截，无真实网络。阶段 4 新增文件。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BAN_NOTICE,
  formatBanConfirmed,
  formatUnbanConfirmed,
  HELP_TEXT,
  NOT_ADMIN_COMMAND_NOTICE,
  UNBOUND_TOPIC_NOTICE,
  UNKNOWN_COMMAND_NOTICE,
} from "../src/copy";
import { handleOutbound } from "../src/pipeline/outbound";
import { handleInbound } from "../src/pipeline/inbound";
import type { TelegramMessageRef } from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import { ensureUser } from "../src/store/users";
import { stubTelegramFetch, type TelegramFetchStub, type StubbedCall } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890;
const ADMIN_ID = 111111111;

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

/** 播种用户行 + topic 绑定（status 可选 closed——命令对 closed 同样可操作） */
async function seedBinding(userId: number, threadId: number, status = "open"): Promise<void> {
  await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: `U${userId}` });
  await env.HODOR_DB.prepare(
    "INSERT INTO topics (bot_id, user_id, thread_id, title, status) VALUES (?, ?, ?, 'seed', ?)",
  )
    .bind(BOT_ID, userId, threadId, status)
    .run();
}

const readBanned = (userId: number) =>
  env.HODOR_DB.prepare("SELECT is_banned FROM users WHERE bot_id = ? AND user_id = ?")
    .bind(BOT_ID, userId)
    .first<{ is_banned: number }>()
    .then((row) => row?.is_banned);

const countLedger = (userId: number) =>
  env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND user_id = ?")
    .bind(BOT_ID, userId)
    .first<{ n: number }>()
    .then((row) => row!.n);

/** 发到客服群 topic 的回复（命令回复的唯一合法去向） */
function topicReplies(stub: TelegramFetchStub, threadId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === SUPPORT_CHAT_ID && body.message_thread_id === threadId;
  });
}

describe("commands: /help（T34）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => {
    stub.restore();
  });

  it("管理员 /help → HELP_TEXT 原文回当前 topic（精确键集）；零用户私聊、零账本——无绑定 topic 也可查看", async () => {
    // thread 640 无任何绑定行：/help 不依赖绑定
    await handleOutbound(env, BOT_ID, commandMessage("/help", 640));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: HELP_TEXT,
      message_thread_id: 640,
    });
    // 唯一 sendMessage 即 topic 回复：无任何发往用户私聊的调用、无账本行
    expect(topicReplies(stub, 640)).toHaveLength(1);
    const totalMessages = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM messages",
    ).first<{ n: number }>();
    expect(totalMessages!.n).toBe(0);
  });

  it("@bot 后缀与附加参数容忍：/help@hodor_bot 现在 → 同一回复（首 token 去 @botname）", async () => {
    await handleOutbound(env, BOT_ID, commandMessage("/help@hodor_bot 现在", 641));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: HELP_TEXT,
      message_thread_id: 641,
    });
  });

  it("closed topic 内 /help → 同样回复（帮助不依赖绑定 / open）", async () => {
    await seedBinding(7240, 642, "closed");
    await handleOutbound(env, BOT_ID, commandMessage("/help", 642));

    expect(stub.callsOf("sendMessage")[0].body).toMatchObject({
      chat_id: SUPPORT_CHAT_ID,
      text: HELP_TEXT,
      message_thread_id: 642,
    });
  });
});

describe("commands: /ban /unban（T35）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => {
    stub.restore();
  });

  it("/ban → setBanned(true) + topic 确认（携带目标用户 ID）；零用户侧消息、零账本、命令文本绝不中继", async () => {
    await seedBinding(7241, 643);

    await handleOutbound(env, BOT_ID, commandMessage("/ban", 643, ADMIN_ID, 71));

    expect(await readBanned(7241)).toBe(1);
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatBanConfirmed(7241),
      message_thread_id: 643,
    });
    // 命令不是对话内容：零中继（无发往 7241 私聊的调用）、零账本
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).chat_id === 7241),
    ).toHaveLength(0);
    expect(await countLedger(7241)).toBe(0);
  });

  it("/unban → setBanned(false) + 确认；/ban@hodor_bot 后缀同样生效", async () => {
    await seedBinding(7242, 644);
    await handleOutbound(env, BOT_ID, commandMessage("/ban@hodor_bot", 644, ADMIN_ID, 72));
    expect(await readBanned(7242)).toBe(1);

    await handleOutbound(env, BOT_ID, commandMessage("/unban", 644, ADMIN_ID, 73));

    expect(await readBanned(7242)).toBe(0);
    expect(stub.callsOf("sendMessage")[1].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatUnbanConfirmed(7242),
      message_thread_id: 644,
    });
    expect(await countLedger(7242)).toBe(0);
  });

  it("closed topic 同样可 /ban（治理操作不依赖 open——不是 T26 无绑定提示）", async () => {
    await seedBinding(7243, 645, "closed");

    await handleOutbound(env, BOT_ID, commandMessage("/ban", 645));

    expect(await readBanned(7243)).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatBanConfirmed(7243),
      message_thread_id: 645,
    });
  });

  it("无绑定 → 复用 T26 提示；users 表零变更（绝不猜测目标用户）", async () => {
    // 文件内 DB 共享：以「前后不变」而非绝对值断言零状态变更
    const bannedCount = async () =>
      (
        await env.HODOR_DB.prepare(
          "SELECT COUNT(*) AS n FROM users WHERE bot_id = ? AND is_banned = 1",
        )
          .bind(BOT_ID)
          .first<{ n: number }>()
      )?.n ?? 0;
    const before = await bannedCount();

    await handleOutbound(env, BOT_ID, commandMessage("/ban", 646));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: UNBOUND_TOPIC_NOTICE,
      message_thread_id: 646,
    });
    expect(await bannedCount()).toBe(before);
  });

  it("解禁后恢复正常门序（未验证用户回到验证门）：ban → 禁言提示无中继；unban → 验证题、仍无中继", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 647 } },
    });
    await seedBinding(7244, 647); // 未验证存量用户 + open 绑定

    // /ban：消息被封禁门拦截（唯一 bot→用户消息 = 禁言提示），不中继不账本
    await handleOutbound(env, BOT_ID, commandMessage("/ban", 647, ADMIN_ID, 80));
    expect(await readBanned(7244)).toBe(1);
    await handleInbound(env, BOT_ID, {
      message_id: 81,
      from: { id: 7244, first_name: "U7244" },
      chat: { id: 7244, type: "private" },
      text: "让我说话",
    });
    const toUserWhenBanned = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7244);
    expect(toUserWhenBanned).toHaveLength(1);
    expect(toUserWhenBanned[0].body).toMatchObject({ text: BAN_NOTICE });
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).message_thread_id === 647 && (call.body as Record<string, unknown>).text === "让我说话"),
    ).toHaveLength(0);
    expect(await countLedger(7244)).toBe(0);

    // /unban：确认后同一条消息回到**验证门**（未验证 → 出题，不中继）
    await handleOutbound(env, BOT_ID, commandMessage("/unban", 647, ADMIN_ID, 82));
    expect(await readBanned(7244)).toBe(0);
    // 禁言提示刚占用了本分钟 slot：倒填释放窗口，验证「回验证门」主旨
    await env.HODOR_DB.prepare(
      "UPDATE users SET last_notice_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7244)
      .run();
    await handleInbound(env, BOT_ID, {
      message_id: 83,
      from: { id: 7244, first_name: "U7244" },
      chat: { id: 7244, type: "private" },
      text: "验证我",
    });
    const toUserAfterUnban = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7244);
    expect(toUserAfterUnban).toHaveLength(2); // 禁言提示 + 新验证题
    expect((toUserAfterUnban[1].body as Record<string, unknown>).reply_markup).toBeDefined();
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).message_thread_id === 647 && (call.body as Record<string, unknown>).text === "验证我"),
    ).toHaveLength(0); // 未验证：仍不中继
    expect(await countLedger(7244)).toBe(0);
  });

  it("确认回复 retryable → 抛（重推重发回复）；is_banned 已先行置位（幂等 setter，重推不翻转）", async () => {
    stub.always("sendMessage", { status: 503, json: { ok: false, description: "upstream boom" } });
    await seedBinding(7245, 648);

    await expect(
      handleOutbound(env, BOT_ID, commandMessage("/ban", 648)),
    ).rejects.toThrow(/sendMessage/);
    expect(await readBanned(7245)).toBe(1); // DB 真值先行
  });

  it("确认回复 permanent → warn 吞（流程完成，不抛）", async () => {
    stub.always("sendMessage", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
    });
    await seedBinding(7246, 649);

    await expect(
      handleOutbound(env, BOT_ID, commandMessage("/unban", 649)),
    ).resolves.toBeUndefined();
    expect(await readBanned(7246)).toBe(0);
  });
});

describe("commands: 未知命令与非管理员（T34）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => {
    stub.restore();
  });

  it("未知命令 /foo → topic 内「未知命令」引导 /help，绝不发给用户、不中继、不账本", async () => {
    await seedBinding(7247, 650);

    await handleOutbound(env, BOT_ID, commandMessage("/foo", 650));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: UNKNOWN_COMMAND_NOTICE,
      message_thread_id: 650,
    });
    expect(await countLedger(7247)).toBe(0);
  });

  it("孤立 / 与客服群内误用的 /start → 同为未知命令提示（入口命令不在此形态生效）", async () => {
    await handleOutbound(env, BOT_ID, commandMessage("/", 651));
    await handleOutbound(env, BOT_ID, commandMessage("/start", 651, ADMIN_ID, 74));

    const replies = topicReplies(stub, 651);
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect((reply.body as Record<string, unknown>).text).toBe(UNKNOWN_COMMAND_NOTICE);
    }
  });

  it("非管理员 / 开头（含 /ban /help）→ 回「仅管理员可用」提示恰发该 thread（验收增量：原静默改为可见反馈）；零状态变更、零账本；非管理员普通文本仍零调用", async () => {
    await seedBinding(7248, 652);

    await handleOutbound(env, BOT_ID, commandMessage("/ban", 652, 999999999));
    await handleOutbound(env, BOT_ID, commandMessage("/help", 652, 999999999));

    expect(stub.countOf("sendMessage")).toBe(2);
    for (const call of stub.callsOf("sendMessage")) {
      expect(call.body).toEqual({
        chat_id: SUPPORT_CHAT_ID,
        text: NOT_ADMIN_COMMAND_NOTICE,
        message_thread_id: 652,
      });
    }
    // 非管理员无治理权：is_banned 不变、命令文本不中继、零账本
    expect(await readBanned(7248)).toBe(0);
    expect(await countLedger(7248)).toBe(0);

    // 非管理员非命令文本：沿用阶段 3 静默（零新调用）
    await handleOutbound(env, BOT_ID, commandMessage("普通发言", 652, 999999999));
    expect(stub.countOf("sendMessage")).toBe(2);
  });
});
