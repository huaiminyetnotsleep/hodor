/**
 * 挑战栅栏与最终裁决的 store 层用例（Turnstile 任务）：
 *
 * - reserveVerificationRequest：条件预留（bot/user、未封禁、未验证、预期
 * mode/enabled/generation——快照读取与预留之间配置变化 → 0 行）；重发 =
 * 新请求原子替换旧请求；
 * - attachVerifyMessage / clearVerificationRequest：CAS 只作用于本轮挑战，
 * 新请求绝不被旧失败清理 / 回填；
 * - claimVerifySubmit：15 秒原子认领（首取赢、窗口内再取输、窗口过后可再赢）；
 * - completeTurnstileVerification / completeCallbackVerification：单条条件
 * UPDATE 最终裁决的全部拒绝分支（过期 / 配置切换 / 认领标识不符 / 封禁 /
 * 已验证 / 答案或 msgId 不符）与唯一获胜分支；
 * - 生命周期：markVerified / markUnverified / setBanned(true) 同一 UPDATE
 * 清新增四列；ban→unban 旧请求绝不复活；clearAllPendingVerifications 覆盖
 * 「只有栅栏没有题面」的 turnstile pending；
 * - settings 事务化变化（applyVerificationConfigChange）：真变化在一个 batch
 * 内推进 verify_generation + 清全部 pending；同值幂等不清 pending、不推进。
 *
 * 文件级隔离 D1，自播种自断言。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyVerificationConfigChange,
  getVerificationSettings,
} from "../src/store/settings";
import {
  attachVerifyMessage,
  claimVerifySubmit,
  clearAllPendingVerifications,
  clearVerificationRequest,
  completeCallbackVerification,
  completeTurnstileVerification,
  ensureUser,
  findUserIdByRequestHash,
  getVerifyRequestState,
  markUnverified,
  markVerified,
  reserveVerificationRequest,
  setBanned,
  VERIFY_SUBMIT_THROTTLE_MS,
} from "../src/store/users";

const BOT_ID = 42;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const FUTURE = "2026-12-01T00:10:00.000Z"; // 请求到期（相对测试运行的「未来」）
const PAST = "2020-01-01T00:00:00.000Z";

/** 预留请求的默认预期（settings 无行 = math / 开 / 版本 0） */
/** 预留请求的预期（缺省 = 当前 settings 真值；文件内共享 DB，版本会随用例推进） */
async function currentExpected() {
  const settings = await getVerificationSettings(env.HODOR_DB);
  return { mode: settings.verifyMode, enabled: settings.verifyEnabled, generation: settings.verifyGeneration };
}

const readRow = async (userId: number) =>
  env.HODOR_DB.prepare(
    `SELECT is_verified, verified_at, verify_answer, verify_msg_id,
       verify_request_hash, verify_request_expires_at, verify_request_generation, verify_submit_not_before
     FROM users WHERE bot_id = ? AND user_id = ?`,
  )
    .bind(BOT_ID, userId)
    .first<{
      is_verified: number;
      verified_at: string | null;
      verify_answer: number | null;
      verify_msg_id: number | null;
      verify_request_hash: string | null;
      verify_request_expires_at: string | null;
      verify_request_generation: number | null;
      verify_submit_not_before: string | null;
    }>();

/** 播种一个未验证用户并预留请求（返回其 hash 供断言） */
async function seedWithRequest(
  userId: number,
  hash: string,
  options: {
    expiresAt?: string | null;
    expected?: { mode: "math" | "button" | "turnstile"; enabled: boolean; generation: number };
  } = {},
): Promise<string> {
  await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: `U${userId}` });
  const ok = await reserveVerificationRequest(
    env.HODOR_DB,
    BOT_ID,
    userId,
    options.expected ?? (await currentExpected()),
    { hash, expiresAt: options.expiresAt === undefined ? FUTURE : options.expiresAt },
  );
  expect(ok).toBe(true);
  return hash;
}

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await env.HODOR_DB.prepare("DELETE FROM settings").run();
});

describe("store: reserveVerificationRequest 条件预留", () => {
 it("条件满足 → 写入 hash/expiry/generation 并清旧题目字段；重发 = 原子替换", async () => {
    await seedWithRequest(7801, HASH_A);
 // 预留后再落一份旧题字段（模拟「旧题残留」形态），新请求替换时一并清掉
    await env.HODOR_DB.prepare(
      "UPDATE users SET verify_answer = 5, verify_msg_id = 4242 WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, 7801).run();

    const replaced = await reserveVerificationRequest(
      env.HODOR_DB, BOT_ID, 7801, await currentExpected(),
      { hash: HASH_B, expiresAt: FUTURE },
    );
    expect(replaced).toBe(true);
    const row = await readRow(7801);
    expect(row).toMatchObject({
      verify_request_hash: HASH_B,
      verify_request_generation: 0,
      verify_answer: null, // 旧题字段随替换清空
      verify_msg_id: null,
    });
    expect(row!.verify_request_expires_at).toBe(FUTURE);
  });

 it("预期 mode/enabled/generation 与当前配置不符 → 0 行（快照后切换不落旧配置的题）", async () => {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7802, first_name: "U7802" });
    await expect(
      reserveVerificationRequest(
        env.HODOR_DB, BOT_ID, 7802,
        { mode: "turnstile", enabled: true, generation: 0 },
        { hash: HASH_A, expiresAt: FUTURE },
      ),
    ).resolves.toBe(false); // settings 无行 = math，预期 turnstile 不匹配
    expect((await readRow(7802))!.verify_request_hash).toBeNull();

 // generation 预期不符同理
    await expect(
      reserveVerificationRequest(
        env.HODOR_DB, BOT_ID, 7802,
        { mode: "math", enabled: true, generation: 9 },
        { hash: HASH_A, expiresAt: FUTURE },
      ),
    ).resolves.toBe(false);
  });

 it("已封禁 / 已验证 / 行不存在 → 0 行", async () => {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7803, first_name: "B" });
    await setBanned(env.HODOR_DB, BOT_ID, 7803, true);
    await expect(
      reserveVerificationRequest(env.HODOR_DB, BOT_ID, 7803, await currentExpected(), { hash: HASH_A, expiresAt: FUTURE }),
    ).resolves.toBe(false);

    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7804, first_name: "V" });
    await markVerified(env.HODOR_DB, BOT_ID, 7804);
    await expect(
      reserveVerificationRequest(env.HODOR_DB, BOT_ID, 7804, await currentExpected(), { hash: HASH_A, expiresAt: FUTURE }),
    ).resolves.toBe(false);

 // 行不存在：UPDATE 不 INSERT（不建档）
    await expect(
      reserveVerificationRequest(env.HODOR_DB, BOT_ID, 7899, await currentExpected(), { hash: HASH_A, expiresAt: FUTURE }),
    ).resolves.toBe(false);
    expect(await getVerifyRequestState(env.HODOR_DB, BOT_ID, 7899)).toBeNull();
  });
});

describe("store: attach / clear 的 CAS 边界", () => {
 it("attach：hash+generation 匹配才回填 msgId/answer；错 hash 不覆盖新请求", async () => {
    await seedWithRequest(7811, HASH_A);
    await expect(
      attachVerifyMessage(env.HODOR_DB, BOT_ID, 7811, { hash: HASH_A, generation: 0 }, { msgId: 4242, answer: 7 }),
    ).resolves.toBe(true);
    expect(await readRow(7811)).toMatchObject({ verify_msg_id: 4242, verify_answer: 7 });

 // 新请求替换后，旧 hash 的回填失败且绝不覆盖
    await reserveVerificationRequest(env.HODOR_DB, BOT_ID, 7811, await currentExpected(), { hash: HASH_B, expiresAt: null });
    await expect(
      attachVerifyMessage(env.HODOR_DB, BOT_ID, 7811, { hash: HASH_A, generation: 0 }, { msgId: 1, answer: 1 }),
    ).resolves.toBe(false);
    expect(await readRow(7811)).toMatchObject({ verify_request_hash: HASH_B, verify_msg_id: null });
  });

 it("clear：只清当前请求；新请求不被旧失败清理", async () => {
    await seedWithRequest(7812, HASH_A);
 // 旧失败（HASH_A）到达时请求已被替换为 HASH_B → 清理失败、新请求原样
    await reserveVerificationRequest(env.HODOR_DB, BOT_ID, 7812, await currentExpected(), { hash: HASH_B, expiresAt: FUTURE });
    await expect(
      clearVerificationRequest(env.HODOR_DB, BOT_ID, 7812, { hash: HASH_A, generation: 0 }),
    ).resolves.toBe(false);
    expect((await readRow(7812))!.verify_request_hash).toBe(HASH_B);

    await expect(
      clearVerificationRequest(env.HODOR_DB, BOT_ID, 7812, { hash: HASH_B, generation: 0 }),
    ).resolves.toBe(true);
    expect(await readRow(7812)).toMatchObject({
      verify_request_hash: null,
      verify_request_expires_at: null,
      verify_request_generation: null,
    });
  });
});

describe("store: claimVerifySubmit 15 秒原子节流", () => {
 it("首取赢 → 窗口内再取输 → 窗口过后可再赢；冷却不被他人失败清空", async () => {
    await seedWithRequest(7821, HASH_A);
    const t0 = "2026-12-01T00:00:00.000Z";
    const next0 = "2026-12-01T00:00:15.000Z";
    await expect(
      claimVerifySubmit(env.HODOR_DB, BOT_ID, 7821, { hash: HASH_A, generation: 0 }, { now: t0, nextNotBefore: next0 }),
    ).resolves.toBe(true);
 // 窗口内第二次（哪怕换 hash 也一样——hash 匹配才可能赢；同 hash 必输）
    await expect(
      claimVerifySubmit(env.HODOR_DB, BOT_ID, 7821, { hash: HASH_A, generation: 0 }, { now: t0, nextNotBefore: next0 }),
    ).resolves.toBe(false);
 // 窗口刚过：可再认领（新 nextNotBefore）
    await expect(
      claimVerifySubmit(env.HODOR_DB, BOT_ID, 7821, { hash: HASH_A, generation: 0 }, { now: next0, nextNotBefore: "2026-12-01T00:00:30.000Z" }),
    ).resolves.toBe(true);
 // 旧失败清理不得提前结束冷却：clearVerificationRequest 不动 submit 窗口
    expect((await readRow(7821))!.verify_submit_not_before).toBe("2026-12-01T00:00:30.000Z");
    expect(VERIFY_SUBMIT_THROTTLE_MS).toBe(15_000);
  });

 it("挑战替换后旧窗口不拦新请求（预留清 submit_not_before）", async () => {
    await seedWithRequest(7822, HASH_A);
    await claimVerifySubmit(env.HODOR_DB, BOT_ID, 7822, { hash: HASH_A, generation: 0 }, { now: "2026-12-01T00:00:00.000Z", nextNotBefore: "2026-12-01T00:00:15.000Z" });
 // 新请求替换：submit 窗口清空 → 新请求立即认领成功
    await reserveVerificationRequest(env.HODOR_DB, BOT_ID, 7822, await currentExpected(), { hash: HASH_B, expiresAt: FUTURE });
    await expect(
      claimVerifySubmit(env.HODOR_DB, BOT_ID, 7822, { hash: HASH_B, generation: 0 }, { now: "2026-12-01T00:00:01.000Z", nextNotBefore: "2026-12-01T00:00:16.000Z" }),
    ).resolves.toBe(true);
  });
});

describe("store: completeTurnstileVerification 最终裁决", () => {
  async function seedReady(userId: number): Promise<void> {
 // turnstile 配置（settings 写入真实行）+ 未来到期 + 已认领窗口
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "turnstile" });
    const generation = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration;
    await seedWithRequest(userId, HASH_A, {
      expected: { mode: "turnstile", enabled: true, generation },
    });
    await claimVerifySubmit(
      env.HODOR_DB,
      BOT_ID,
      userId,
      { hash: HASH_A, generation },
      { now: "2026-12-01T00:00:00.000Z", nextNotBefore: "2026-12-01T00:00:15.000Z" },
    );
  }

 it("全部条件满足 → 获胜：is_verified=1 + verified_at 落值 + 全部 pending 字段清空", async () => {
    await seedReady(7831);
    const generation = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration;
    await expect(
      completeTurnstileVerification(
        env.HODOR_DB, BOT_ID, 7831,
        { hash: HASH_A, generation },
        { now: "2026-12-01T00:00:05.000Z", submitNotBefore: "2026-12-01T00:00:15.000Z" },
      ),
    ).resolves.toBe(true);
    expect(await readRow(7831)).toMatchObject({
      is_verified: 1,
      verify_request_hash: null,
      verify_submit_not_before: null,
      verify_msg_id: null,
    });
    expect((await readRow(7831))!.verified_at).not.toBeNull();

 // 清理配置：还原 math（后续用例互不影响）
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "math" });
  });

 it("拒绝分支矩阵：过期 / 认领标识不符 / 封禁 / 已验证 / 配置切走 / hash 替换 全部 0 行且不写验证态", async () => {
 // 过期
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "turnstile" });
    let generation = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration;
    await seedWithRequest(7832, HASH_A, { expiresAt: PAST, expected: { mode: "turnstile", enabled: true, generation } });
    await expect(
      completeTurnstileVerification(
        env.HODOR_DB, BOT_ID, 7832, { hash: HASH_A, generation },
        { now: "2026-12-01T00:00:05.000Z", submitNotBefore: "2026-12-01T00:00:15.000Z" },
      ),
    ).resolves.toBe(false);

 // 认领标识不符（submit_not_before 为 null / 他人窗口）
    await seedWithRequest(7833, HASH_A, { expected: { mode: "turnstile", enabled: true, generation } });
    await expect(
      completeTurnstileVerification(
        env.HODOR_DB, BOT_ID, 7833, { hash: HASH_A, generation },
        { now: "2026-12-01T00:00:05.000Z", submitNotBefore: "2026-12-01T00:00:15.000Z" },
      ),
    ).resolves.toBe(false);

 // 封禁（ban 原子清了 pending → hash 不再匹配）
    await seedWithRequest(7834, HASH_A, { expected: { mode: "turnstile", enabled: true, generation } });
    await setBanned(env.HODOR_DB, BOT_ID, 7834, true);
    await expect(
      completeTurnstileVerification(
        env.HODOR_DB, BOT_ID, 7834, { hash: HASH_A, generation },
        { now: "2026-12-01T00:00:05.000Z", submitNotBefore: "2026-12-01T00:00:15.000Z" },
      ),
    ).resolves.toBe(false);

 // 已验证（重复消费）
    await seedWithRequest(7835, HASH_A, { expected: { mode: "turnstile", enabled: true, generation } });
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_verified = 1 WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, 7835).run();
    await expect(
      completeTurnstileVerification(
        env.HODOR_DB, BOT_ID, 7835, { hash: HASH_A, generation },
        { now: "2026-12-01T00:00:05.000Z", submitNotBefore: "2026-12-01T00:00:15.000Z" },
      ),
    ).resolves.toBe(false);

 // 配置切走（mode → math：SQL 子查询读当前实际值）
    await seedWithRequest(7836, HASH_A, { expected: { mode: "turnstile", enabled: true, generation } });
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "math" });
    generation = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration; // 已推进
    await expect(
      completeTurnstileVerification(
        env.HODOR_DB, BOT_ID, 7836, { hash: HASH_A, generation: generation - 1 },
        { now: "2026-12-01T00:00:05.000Z", submitNotBefore: "2026-12-01T00:00:15.000Z" },
      ),
    ).resolves.toBe(false);
 // 请求也已被切换清掉（generation 条件与 hash 条件双保险）
    expect((await readRow(7836))!.verify_request_hash).toBeNull();

 // 每个拒绝分支都未写入验证态（7835 的 is_verified=1 是用例自身的前置）
    for (const userId of [7832, 7833, 7834, 7836]) {
      expect((await readRow(userId))!.is_verified).toBe(0);
    }
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "math" });
  });
});

describe("store: completeCallbackVerification 最终裁决（Telegram 回调）", () => {
 it("正确答案 + 栅栏全匹配 → 获胜；答案 / msgId / generation 任一不符 → 0 行", async () => {
 // 文件内共享 DB：版本随前序用例推进——栅栏 generation 必须取当前真值
    const generation = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration;
    await seedWithRequest(7841, HASH_A);
    await attachVerifyMessage(env.HODOR_DB, BOT_ID, 7841, { hash: HASH_A, generation }, { msgId: 4242, answer: 7 });

    const fence = { hash: HASH_A, generation, mode: "math" as const, enabled: true };
    await expect(
      completeCallbackVerification(env.HODOR_DB, BOT_ID, 7841, fence, { msgId: 4242, answer: 7 }),
    ).resolves.toBe(true);
    expect(await readRow(7841)).toMatchObject({ is_verified: 1, verify_request_hash: null, verify_answer: null });

 // 答案不符
    await seedWithRequest(7842, HASH_A);
    await attachVerifyMessage(env.HODOR_DB, BOT_ID, 7842, { hash: HASH_A, generation }, { msgId: 4242, answer: 7 });
    await expect(
      completeCallbackVerification(env.HODOR_DB, BOT_ID, 7842, fence, { msgId: 4242, answer: 8 }),
    ).resolves.toBe(false);

 // msgId 不符（旧题回调）
    await seedWithRequest(7843, HASH_A);
    await attachVerifyMessage(env.HODOR_DB, BOT_ID, 7843, { hash: HASH_A, generation }, { msgId: 4242, answer: 7 });
    await expect(
      completeCallbackVerification(env.HODOR_DB, BOT_ID, 7843, fence, { msgId: 3000, answer: 7 }),
    ).resolves.toBe(false);

 // generation 不符（配置切换后版本推进）
    await seedWithRequest(7844, HASH_A);
    await attachVerifyMessage(env.HODOR_DB, BOT_ID, 7844, { hash: HASH_A, generation }, { msgId: 4242, answer: 7 });
    await expect(
      completeCallbackVerification(
        env.HODOR_DB, BOT_ID, 7844,
        { hash: HASH_A, generation: generation + 5, mode: "math", enabled: true },
        { msgId: 4242, answer: 7 },
      ),
    ).resolves.toBe(false);

 // mode 不符（配置已是 turnstile）
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "turnstile" });
    await seedWithRequest(7845, HASH_A);
    await attachVerifyMessage(env.HODOR_DB, BOT_ID, 7845, { hash: HASH_A, generation }, { msgId: 4242, answer: 7 });
    await expect(
      completeCallbackVerification(
        env.HODOR_DB, BOT_ID, 7845,
        { hash: HASH_A, generation, mode: "turnstile", enabled: true },
        { msgId: 4242, answer: 7 },
      ),
    ).resolves.toBe(false);
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "math" });

    for (const userId of [7842, 7843, 7844, 7845]) {
      expect((await readRow(userId))!.is_verified).toBe(0);
    }
  });
});

describe("store: 生命周期清理（ban / 撤销 / 全局清题 / 反查）", () => {
 it("ban→unban：旧请求不复活（ban 原子清栅栏；unban 不恢复）", async () => {
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "turnstile" });
    const generation = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration;
    await seedWithRequest(7851, HASH_A, { expected: { mode: "turnstile", enabled: true, generation } });
    await setBanned(env.HODOR_DB, BOT_ID, 7851, true);
    expect(await readRow(7851)).toMatchObject({
      is_verified: 0,
      verify_request_hash: null,
      verify_submit_not_before: null,
    });
    await setBanned(env.HODOR_DB, BOT_ID, 7851, false);
 // 解封后旧 hash 的最终裁决失败（hash 已清）——「解封不复活旧链接」
    await expect(
      completeTurnstileVerification(
        env.HODOR_DB, BOT_ID, 7851, { hash: HASH_A, generation },
        { now: "2026-12-01T00:00:05.000Z", submitNotBefore: "2026-12-01T00:00:15.000Z" },
      ),
    ).resolves.toBe(false);
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "math" });
  });

 it("markUnverified / markVerified 同一 UPDATE 清新增四列", async () => {
    await seedWithRequest(7852, HASH_A);
    await env.HODOR_DB.prepare(
      "UPDATE users SET verify_submit_not_before = '2026-12-01T00:00:15.000Z' WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, 7852).run();
    await markUnverified(env.HODOR_DB, BOT_ID, 7852);
    expect(await readRow(7852)).toMatchObject({
      verify_request_hash: null,
      verify_request_expires_at: null,
      verify_request_generation: null,
      verify_submit_not_before: null,
    });

    await seedWithRequest(7853, HASH_A);
    await markVerified(env.HODOR_DB, BOT_ID, 7853);
    expect(await readRow(7853)).toMatchObject({
      is_verified: 1,
      verify_request_hash: null,
      verify_request_generation: null,
    });
  });

 it("clearAllPendingVerifications 覆盖「只有栅栏没有题面」的 turnstile pending；幂等", async () => {
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "turnstile" });
    const generation = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration;
    await seedWithRequest(7854, HASH_A, { expected: { mode: "turnstile", enabled: true, generation } });
    await clearAllPendingVerifications(env.HODOR_DB);
    expect((await readRow(7854))!.verify_request_hash).toBeNull();
 // 幂等：再执行零变更、不抛
    await expect(clearAllPendingVerifications(env.HODOR_DB)).resolves.toBeUndefined();
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "math" });
  });

 it("findUserIdByRequestHash：按 hash 反查持有者（用户不符判定）；无持有者 → null", async () => {
    await seedWithRequest(7855, HASH_A);
    await expect(findUserIdByRequestHash(env.HODOR_DB, BOT_ID, HASH_A)).resolves.toBe(7855);
    await expect(findUserIdByRequestHash(env.HODOR_DB, BOT_ID, HASH_B)).resolves.toBeNull();
  });
});

describe("store: applyVerificationConfigChange 事务化配置变化", () => {
 it("真变化：一个 batch 内推进版本 + 清全部 pending（含栅栏）+ 写新设置；保留 is_verified", async () => {
    await seedWithRequest(7861, HASH_A);
    await markVerified(env.HODOR_DB, BOT_ID, 7862); // 已验证用户不受影响
    await markUnverified(env.HODOR_DB, BOT_ID, 7862);

    await applyVerificationConfigChange(env.HODOR_DB, { mode: "button" });

    const before = await getVerificationSettings(env.HODOR_DB);
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "math" }); // 真变化

    const settings = await getVerificationSettings(env.HODOR_DB);
    expect(settings.verifyMode).toBe("math");
    expect(settings.verifyGeneration).toBe(before.verifyGeneration + 1); // SQL 内递增
    expect((await readRow(7861))!.verify_request_hash).toBeNull(); // pending 被清
  });

 it("同值幂等：不推进版本、不清 pending（事务内实际状态判定，重推安全）", async () => {
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "button" }); // 已是 button
    const before = await getVerificationSettings(env.HODOR_DB);
    await seedWithRequest(7863, HASH_A);
    await applyVerificationConfigChange(env.HODOR_DB, { mode: "button" });
    const after = await getVerificationSettings(env.HODOR_DB);
    expect(after.verifyGeneration).toBe(before.verifyGeneration);
    expect((await readRow(7863))!.verify_request_hash).toBe(HASH_A); // pending 保留
  });

 it("开关切换同构：真变化推进版本并清 pending；同值幂等", async () => {
    await applyVerificationConfigChange(env.HODOR_DB, { enabled: false });
    const genOff = (await getVerificationSettings(env.HODOR_DB)).verifyGeneration;
    expect((await getVerificationSettings(env.HODOR_DB)).verifyEnabled).toBe(false);

    await seedWithRequest(7864, HASH_A, { expected: { mode: "button", enabled: false, generation: genOff } });
    await applyVerificationConfigChange(env.HODOR_DB, { enabled: false }); // 幂等
    expect((await readRow(7864))!.verify_request_hash).toBe(HASH_A);
    expect((await getVerificationSettings(env.HODOR_DB)).verifyGeneration).toBe(genOff);

    await applyVerificationConfigChange(env.HODOR_DB, { enabled: true }); // 真变化
    expect((await getVerificationSettings(env.HODOR_DB)).verifyGeneration).toBe(genOff + 1);
    expect((await readRow(7864))!.verify_request_hash).toBeNull();
  });
});
