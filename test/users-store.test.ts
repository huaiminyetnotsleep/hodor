/**
 * users 表 store（T23 改造）：ensureUser 三态返回（新建 / 展示变更 / 纯活跃
 * 刷新——治理列与 first_seen_at 永不动）+ claimNoticeSlot 原子频控
 * （首取赢、60s 内再取输、窗口过后可再赢、行不存在 → 输）。
 * 文件级隔离 D1，自播种自断言。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { claimNoticeSlot, ensureUser } from "../src/store/users";

const BOT_ID = 42;
const USER_ID = 7501;

interface UserRow {
  first_name: string;
  last_name: string;
  username: string;
  status: string;
  is_banned: number;
  is_verified: number;
  last_notice_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

const readUser = () =>
  env.HODOR_DB.prepare(
    "SELECT first_name, last_name, username, status, is_banned, is_verified, last_notice_at, first_seen_at, last_seen_at FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, USER_ID)
    .first<UserRow>();

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

describe("store: ensureUser 三态返回", () => {
  it("无行 → INSERT：{ isNew: true, displayChanged: false }，firstSeenAt 与库一致，治理列走默认值", async () => {
    const result = await ensureUser(env.HODOR_DB, BOT_ID, {
      id: USER_ID,
      first_name: "Alice",
      last_name: "L",
      username: "alice_hd",
    });
    expect(result.isNew).toBe(true);
    expect(result.displayChanged).toBe(false);

    const row = await readUser();
    expect(row).toMatchObject({
      first_name: "Alice",
      last_name: "L",
      username: "alice_hd",
      status: "active",
      is_banned: 0,
      is_verified: 0,
      last_notice_at: null,
    });
    // 返回值与库内建档时间一致（显式传 nowIso 的意义）
    expect(result.firstSeenAt).toBe(row!.first_seen_at);
    expect(result.firstSeenAt).toBe(row!.last_seen_at);
  });

  it("展示字段变化 → { isNew: false, displayChanged: true }，昵称缓存刷新、firstSeenAt 保留首行值", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE users SET first_seen_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, USER_ID)
      .run();

    const result = await ensureUser(env.HODOR_DB, BOT_ID, {
      id: USER_ID,
      first_name: "新名",
      username: "new_hd",
    });
    expect(result).toEqual({
      isNew: false,
      displayChanged: true,
      firstSeenAt: "2020-01-01T00:00:00.000Z",
    });

    const row = await readUser();
    expect(row).toMatchObject({
      first_name: "新名",
      last_name: "", // 未携带字段归一为空串（与 from 缺省语义一致）
      username: "new_hd",
      first_seen_at: "2020-01-01T00:00:00.000Z", // 不被覆盖
    });
  });

  it("展示字段无变化 → { isNew: false, displayChanged: false }，仅刷新 last_seen_at", async () => {
    const before = await readUser();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await ensureUser(env.HODOR_DB, BOT_ID, {
      id: USER_ID,
      first_name: "新名",
      username: "new_hd",
    });
    expect(result).toEqual({
      isNew: false,
      displayChanged: false,
      firstSeenAt: before!.first_seen_at,
    });

    const row = await readUser();
    expect(row!.last_seen_at > before!.last_seen_at).toBe(true);
    expect(row!.first_name).toBe("新名");
  });

  it("治理列在更新分支永不动：预置 is_banned=1 后刷新展示字段，is_banned 保持", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_banned = 1, status = 'active' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, USER_ID)
      .run();

    const result = await ensureUser(env.HODOR_DB, BOT_ID, {
      id: USER_ID,
      first_name: "又改名",
    });
    expect(result.displayChanged).toBe(true);

    const row = await readUser();
    expect(row!.is_banned).toBe(1);
    expect(row!.status).toBe("active");
  });
});

describe("store: claimNoticeSlot 原子频控", () => {
  const SLOT_USER = 7502;

  it("新用户行（last_notice_at NULL）→ 首取赢；60s 内再取输；行不存在 → 输", async () => {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: SLOT_USER, first_name: "Slot" });

    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(true);
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(false);
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(false);
    // 行不存在（防御式）：UPDATE 零行变更 = 输
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, 999999999)).toBe(false);
  });

  it("写旧值（> 60s 前）→ 可再赢；写未来值 → 输", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE users SET last_notice_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, SLOT_USER)
      .run();
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(true);

    await env.HODOR_DB.prepare(
      "UPDATE users SET last_notice_at = '2999-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, SLOT_USER)
      .run();
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(false);
  });
});
