/**
 * broadcasts store 直测（全用户广播）：
 * - 资格语义：映射存在 + users 行存在 + 未封禁；软归档 /
 * closed / 未验证一律纳入；孤儿映射与其他 bot 排除；
 * - 状态机原子转移：confirm（won/busy/lost）、cancel、expire、complete
 * （sending 与 failed 皆可收敛为 completed）、惰性清理两规则；
 * - decodeRecipientIds fail-closed（≤500 个正安全整数、升序、无重复）。
 *
 * 直接消费 store 函数 + env.HODOR_DB（schema.test.ts 同款姿态），不经 webhook。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BROADCAST_RECIPIENT_LIMIT,
  cancelActiveBroadcasts,
  cancelBroadcast,
  cleanupStaleBroadcasts,
  completeBroadcast,
  confirmBroadcast,
  countEligibleRecipients,
  decodeRecipientIds,
  expireBroadcast,
  findActiveDraft,
  findBroadcastById,
  findBroadcastBySourceUpdate,
  insertPreparingBroadcast,
  listEligibleRecipients,
  setBroadcastPendingWithControlMsgId,
  setBroadcastPreviewMsgId,
} from "../src/store/broadcasts";
import { wipeAllUserData } from "../src/store/wipe";
import { nowIso } from "../src/store/util";

const BOT_ID = 42;
const OTHER_BOT_ID = 43;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

/** 播种用户 + 映射（绕过入站管线；字段按测试需要覆盖） */
async function seedRecipient(
  userId: number,
  threadId: number,
  options: { banned?: boolean; userStatus?: string; topicStatus?: string; verified?: boolean } = {},
): Promise<void> {
  await env.HODOR_DB.prepare(
    `INSERT INTO users (bot_id, user_id, status, is_banned, is_verified)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(BOT_ID, userId, options.userStatus ?? "active", options.banned ? 1 : 0, options.verified ? 1 : 0)
    .run();
  await env.HODOR_DB.prepare(
    "INSERT INTO topics (bot_id, user_id, thread_id, title, status) VALUES (?, ?, ?, 'seed', ?)",
  )
    .bind(BOT_ID, userId, threadId, options.topicStatus ?? "open")
    .run();
}

/** 插入一条任意状态的广播行（直写 SQL，测试状态机用） */
async function seedBroadcast(
  sourceUpdateId: number,
  status: string,
  options: { expiresInMs?: number; updatedAgoMs?: number; botId?: number } = {},
): Promise<number> {
  const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 5 * 60_000)).toISOString();
  const updatedAt = new Date(Date.now() - (options.updatedAgoMs ?? 0)).toISOString();
  await env.HODOR_DB.prepare(
    `INSERT INTO broadcasts
       (bot_id, source_update_id, initiator_user_id, support_chat_id, message_html, status, expires_at, updated_at)
     VALUES (?, ?, 111111111, -1001234567890, '<b>x</b>', ?, ?, ?)`,
  )
    .bind(options.botId ?? BOT_ID, sourceUpdateId, status, expiresAt, updatedAt)
    .run();
  const row = await findBroadcastBySourceUpdate(env.HODOR_DB, options.botId ?? BOT_ID, sourceUpdateId);
  return row!.id;
}

const resetBroadcasts = async () => {
  await env.HODOR_DB.prepare("DELETE FROM broadcasts").run();
};

describe("broadcast store: 资格语义", () => {
 it("封禁排除；软归档 / closed / 未验证 / TTL 无关纳入；孤儿映射与其他 bot 排除；升序返回", async () => {
    await seedRecipient(300, 1); // 正常
    await seedRecipient(200, 2, { banned: true }); // 封禁 → 排除
    await seedRecipient(500, 3, { userStatus: "deleted", topicStatus: "closed" }); // 软归档 + closed → 纳入
    await seedRecipient(400, 4, { verified: false }); // 未验证 → 纳入
    await seedRecipient(600, 5, { topicStatus: "closed" }); // closed → 纳入
 // 孤儿映射（topic 无 users 行）→ INNER JOIN 排除
    await env.HODOR_DB.prepare(
      "INSERT INTO topics (bot_id, user_id, thread_id, title) VALUES (?, 999, 6, 'orphan')",
    )
      .bind(BOT_ID)
      .run();
 // 其他 bot → 排除
    await env.HODOR_DB.prepare(
      "INSERT INTO users (bot_id, user_id) VALUES (?, 700)",
    )
      .bind(OTHER_BOT_ID)
      .run();
    await env.HODOR_DB.prepare(
      "INSERT INTO topics (bot_id, user_id, thread_id, title) VALUES (?, 700, 7, 'other-bot')",
    )
      .bind(OTHER_BOT_ID)
      .run();

    const eligible = await listEligibleRecipients(env.HODOR_DB, BOT_ID);
    expect(eligible).toEqual([300, 400, 500, 600]);
    expect(await countEligibleRecipients(env.HODOR_DB, BOT_ID)).toBe(4);
    expect(await countEligibleRecipients(env.HODOR_DB, OTHER_BOT_ID)).toBe(1);
  });
});

describe("broadcast store: preparing → pending 创建与幂等复用", () => {
 it("insert → 按 source_update_id 复用同一行；preview / control 补齐进入 pending", async () => {
    await resetBroadcasts();
    await insertPreparingBroadcast(env.HODOR_DB, {
      botId: BOT_ID,
      sourceUpdateId: 9100,
      initiatorUserId: 111111111,
      supportChatId: -1001234567890,
      messageHtml: "<b>hello</b>",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const first = await findBroadcastBySourceUpdate(env.HODOR_DB, BOT_ID, 9100);
    expect(first).not.toBeNull();
    expect(first!.status).toBe("preparing");

 // 幂等复用读取（不重复插入——重复插入由 UNIQUE 兜底拒绝）
    const again = await findBroadcastBySourceUpdate(env.HODOR_DB, BOT_ID, 9100);
    expect(again!.id).toBe(first!.id);
    expect(await findActiveDraft(env.HODOR_DB, BOT_ID)?.then((r) => r?.id)).toBe(first!.id);

    await setBroadcastPreviewMsgId(env.HODOR_DB, BOT_ID, first!.id, 7001);
    await setBroadcastPendingWithControlMsgId(env.HODOR_DB, BOT_ID, first!.id, 7002);
    const pending = await findBroadcastById(env.HODOR_DB, BOT_ID, first!.id);
    expect(pending!.preview_msg_id).toBe(7001);
    expect(pending!.control_msg_id).toBe(7002);
    expect(pending!.status).toBe("pending");
 // 进入 pending 后仍是唯一草稿（pending 同占草稿唯一索引）
    expect((await findActiveDraft(env.HODOR_DB, BOT_ID))!.id).toBe(first!.id);
  });
});

describe("broadcast store: 惰性清理", () => {
  // 「每 Bot 恰一份草稿」唯一索引约束同一 bot 不能并存两份草稿——各场景
  // 串行执行（重置 → 播种 → 清理 → 断言），共用同一 bot 维度
  const statusOf = async (id: number) =>
    (await findBroadcastById(env.HODOR_DB, BOT_ID, id))!.status;

 it("过期的 preparing / pending → expired；未过期不动", async () => {
    await resetBroadcasts();
    const expiredPreparing = await seedBroadcast(9201, "preparing", { expiresInMs: -60_000 });
    await cleanupStaleBroadcasts(env.HODOR_DB, BOT_ID);
    expect(await statusOf(expiredPreparing)).toBe("expired");

    await resetBroadcasts();
    const expiredPending = await seedBroadcast(9202, "pending", { expiresInMs: -1 });
    await cleanupStaleBroadcasts(env.HODOR_DB, BOT_ID);
    expect(await statusOf(expiredPending)).toBe("expired");

    await resetBroadcasts();
    const freshPending = await seedBroadcast(9203, "pending", { expiresInMs: 60_000 });
    await cleanupStaleBroadcasts(env.HODOR_DB, BOT_ID);
    expect(await statusOf(freshPending)).toBe("pending");
  });

 it("滞留 sending（updated_at 超 10 分钟）→ failed；新鲜 sending 与终态行不动", async () => {
    await resetBroadcasts();
    const staleSending = await seedBroadcast(9204, "sending", {
      updatedAgoMs: 10 * 60_000 + 1000,
    });
    await cleanupStaleBroadcasts(env.HODOR_DB, BOT_ID);
    expect(await statusOf(staleSending)).toBe("failed");

    await resetBroadcasts();
    const freshSending = await seedBroadcast(9205, "sending", { updatedAgoMs: 60_000 });
    const terminal = await seedBroadcast(9206, "completed", { expiresInMs: -60_000 });
    await cleanupStaleBroadcasts(env.HODOR_DB, BOT_ID);
    expect(await statusOf(freshSending)).toBe("sending");
    expect(await statusOf(terminal)).toBe("completed"); // 终态不受清理影响
  });
});

describe("broadcast store: 原子确认 / 取消 / 过期", () => {
 it("确认胜出：pending → sending + 冻结升序 JSON + expected_count + confirmed_at", async () => {
    await resetBroadcasts();
    const id = await seedBroadcast(9301, "pending");
    const outcome = await confirmBroadcast(env.HODOR_DB, {
      botId: BOT_ID,
      id,
      initiatorUserId: 111111111,
      recipientIdsJson: JSON.stringify([200, 300]),
      expectedCount: 2,
      now: nowIso(),
    });
    expect(outcome).toBe("won");
    const row = await findBroadcastById(env.HODOR_DB, BOT_ID, id)!;
    expect(row!.status).toBe("sending");
    expect(row!.recipient_ids_json).toBe("[200,300]");
    expect(row!.expected_count).toBe(2);
    expect(row!.confirmed_at).not.toBeNull();
  });

 it("已有 sending（其他行）→ busy，pending 保留；发起人不符 / 非 pending / 已过期 → lost", async () => {
    await resetBroadcasts();
 // 另一份发送中广播占用「每 Bot 恰一份 sending」
    await seedBroadcast(9310, "sending");
    const pending = await seedBroadcast(9311, "pending");

    const busy = await confirmBroadcast(env.HODOR_DB, {
      botId: BOT_ID,
      id: pending,
      initiatorUserId: 111111111,
      recipientIdsJson: "[]",
      expectedCount: 0,
      now: nowIso(),
    });
    expect(busy).toBe("busy");
    expect((await findBroadcastById(env.HODOR_DB, BOT_ID, pending))!.status).toBe("pending");

 // 发起人不符
    expect(
      await confirmBroadcast(env.HODOR_DB, {
        botId: BOT_ID,
        id: pending,
        initiatorUserId: 222222222,
        recipientIdsJson: "[]",
        expectedCount: 0,
        now: nowIso(),
      }),
    ).toBe("lost");

 // 已过期（expires_at 已过）→ lost，状态仍 pending（由过期分支收敛）
    await resetBroadcasts();
    const expired = await seedBroadcast(9312, "pending", { expiresInMs: -1_000 });
    expect(
      await confirmBroadcast(env.HODOR_DB, {
        botId: BOT_ID,
        id: expired,
        initiatorUserId: 111111111,
        recipientIdsJson: "[]",
        expectedCount: 0,
        now: nowIso(),
      }),
    ).toBe("lost");
    expect((await findBroadcastById(env.HODOR_DB, BOT_ID, expired))!.status).toBe("pending");
  });

 it("取消胜出 pending → cancelled；已过期取消 → false（由过期分支处理）", async () => {
    await resetBroadcasts();
    const id = await seedBroadcast(9320, "pending");
    expect(
      await cancelBroadcast(env.HODOR_DB, { botId: BOT_ID, id, initiatorUserId: 111111111, now: nowIso() }),
    ).toBe(true);
    expect((await findBroadcastById(env.HODOR_DB, BOT_ID, id))!.status).toBe("cancelled");
 // 二次取消（非 pending）→ false
    expect(
      await cancelBroadcast(env.HODOR_DB, { botId: BOT_ID, id, initiatorUserId: 111111111, now: nowIso() }),
    ).toBe(false);

    const expired = await seedBroadcast(9321, "pending", { expiresInMs: -1_000 });
    expect(
      await cancelBroadcast(env.HODOR_DB, { botId: BOT_ID, id: expired, initiatorUserId: 111111111, now: nowIso() }),
    ).toBe(false);
  });

 it("expireBroadcast：仅命中已过期的 pending；新鲜 pending 返回 false", async () => {
    await resetBroadcasts();
    const now = nowIso();
    const expired = await seedBroadcast(9330, "pending", { expiresInMs: -1 });
    expect(await expireBroadcast(env.HODOR_DB, BOT_ID, expired, now)).toBe(true);

    await resetBroadcasts();
    const fresh = await seedBroadcast(9331, "pending");
    expect(await expireBroadcast(env.HODOR_DB, BOT_ID, fresh, now)).toBe(false);
    expect((await findBroadcastById(env.HODOR_DB, BOT_ID, fresh))!.status).toBe("pending");
  });
});

describe("broadcast store: 完成写入与终态语义", () => {
 it("只有 sending 可写入 completed 及计数；failed 中断行不能误报完成", async () => {
    await resetBroadcasts();
    const sending = await seedBroadcast(9340, "sending");
    expect(
      await completeBroadcast(env.HODOR_DB, {
        botId: BOT_ID,
        id: sending,
        successCount: 298,
        failureCount: 2,
        now: nowIso(),
      }),
    ).toBe(true);
    const done = await findBroadcastById(env.HODOR_DB, BOT_ID, sending)!;
    expect(done!.status).toBe("completed");
    expect(done!.success_count).toBe(298);
    expect(done!.failure_count).toBe(2);

    const failed = await seedBroadcast(9341, "failed");
    expect(
      await completeBroadcast(env.HODOR_DB, {
        botId: BOT_ID,
        id: failed,
        successCount: 1,
        failureCount: 0,
        now: nowIso(),
      }),
    ).toBe(false);
    expect((await findBroadcastById(env.HODOR_DB, BOT_ID, failed))!.status).toBe("failed");
  });

 it("pending / cancelled 行不可直接 completed；行不存在 → false", async () => {
    await resetBroadcasts();
    const pending = await seedBroadcast(9342, "pending");
    expect(
      await completeBroadcast(env.HODOR_DB, {
        botId: BOT_ID,
        id: pending,
        successCount: 0,
        failureCount: 0,
        now: nowIso(),
      }),
    ).toBe(false);
    expect(
      await completeBroadcast(env.HODOR_DB, {
        botId: BOT_ID,
        id: 999999,
        successCount: 0,
        failureCount: 0,
        now: nowIso(),
      }),
    ).toBe(false);
  });
});

describe("broadcast store: decodeRecipientIds fail-closed", () => {
 it("合法：空数组与升序正整数数组", () => {
    expect(decodeRecipientIds("[]")).toEqual([]);
    expect(decodeRecipientIds("[1,2,300]")).toEqual([1, 2, 300]);
  });

 it("非法一律 null：非数组、损坏 JSON、非正整数、零、负数、重复、降序、超 500 上限", () => {
    expect(decodeRecipientIds("not-json")).toBeNull();
    expect(decodeRecipientIds('{"a":1}')).toBeNull();
    expect(decodeRecipientIds('["1","2"]')).toBeNull();
    expect(decodeRecipientIds("[1.5]")).toBeNull();
    expect(decodeRecipientIds("[0]")).toBeNull();
    expect(decodeRecipientIds("[-5]")).toBeNull();
    expect(decodeRecipientIds("[3,3]")).toBeNull();
    expect(decodeRecipientIds("[5,3]")).toBeNull();
    expect(decodeRecipientIds(`[1,${Number.MAX_SAFE_INTEGER + 1}]`)).toBeNull();
    const tooMany = JSON.stringify(Array.from({ length: BROADCAST_RECIPIENT_LIMIT + 1 }, (_, i) => i + 1));
    expect(decodeRecipientIds(tooMany)).toBeNull();
 // 500 个恰好合法
    const atLimit = JSON.stringify(Array.from({ length: BROADCAST_RECIPIENT_LIMIT }, (_, i) => i + 1));
    expect(decodeRecipientIds(atLimit)).toHaveLength(BROADCAST_RECIPIENT_LIMIT);
  });
});

describe("broadcast store: 清库联动", () => {
  // 本 describe 有意放在文件末尾：wipeAllUserData 全表清空 users/topics 等
  // 共享播种数据（文件级 D1，其后无其他用例）
 it("sending 被清库取消后标记 failed（结果未知），preparing/pending 标记 cancelled；终态不动", async () => {
    await resetBroadcasts();
    const preparing = await seedBroadcast(9401, "preparing");
    const pending = await seedBroadcast(9402, "pending", { botId: OTHER_BOT_ID });
    const sending = await seedBroadcast(9403, "sending");
    const done = await seedBroadcast(9404, "completed");

    await cancelActiveBroadcasts(env.HODOR_DB, BOT_ID);
    await cancelActiveBroadcasts(env.HODOR_DB, OTHER_BOT_ID);

    const statusOf = async (id: number, botId = BOT_ID) =>
      (await findBroadcastById(env.HODOR_DB, botId, id))!.status;
    expect(await statusOf(preparing)).toBe("cancelled");
    expect(await statusOf(pending, OTHER_BOT_ID)).toBe("cancelled");
    expect(await statusOf(sending)).toBe("failed");
    expect(await statusOf(done)).toBe("completed");
  });

 it("wipeAllUserData 清空 broadcasts 表", async () => {
    await resetBroadcasts();
    await seedBroadcast(9411, "cancelled");
    await wipeAllUserData(env.HODOR_DB);
    const remaining = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM broadcasts",
    ).first<{ n: number }>();
    expect(remaining!.n).toBe(0);
  });
});
