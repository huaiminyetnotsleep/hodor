// 八表齐备 + 关键约束生效 + settings 读写冒烟（0005 broadcasts 随全用户广播任务加入）
// 原则：直接用 env.HODOR_DB 裸 SQL 断言 schema 本身
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

// 每个测试文件对各自的隔离 D1 应用迁移（文件间存储隔离，各自重建）
beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

describe("schema: 八表齐备", () => {
 it("sqlite_master 恰好包含八张业务表", async () => {
    const { results } = await env.HODOR_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'" +
 // 排除内部表：sqlite_%（SQLite 内部）、d1_migrations（wrangler 迁移台账）、
 // 下划线开头（D1 本地实现自带的 _cf_METADATA 等）
        " AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'" +
        " AND substr(name, 1, 1) != '_' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual([
      "bots",
      "broadcasts",
      "delete_confirmations",
      "messages",
      "processed_updates",
      "settings",
      "topics",
      "users",
    ]);
  });
});

describe("schema: CHECK 约束", () => {
 it("users.status 非法值被拒绝", async () => {
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO users (bot_id, user_id, status) VALUES (1, 100, 'bogus')",
      ).run(),
    ).rejects.toThrow(); // D1 错误以 rejected promise 形式抛出
  });
});

describe("schema: topics 双向唯一", () => {
 it("(bot_id, thread_id) 重复插入被拒；同 user 换 thread 更新成功", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO topics (bot_id, user_id, thread_id) VALUES (1, 100, 500)",
    ).run();

 // 不同 user 复用同 (bot_id, thread_id) → UNIQUE 索引拒绝
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO topics (bot_id, user_id, thread_id) VALUES (1, 200, 500)",
      ).run(),
    ).rejects.toThrow();

 // 同 user 更新到新 thread → 允许
    await env.HODOR_DB.prepare(
      "UPDATE topics SET thread_id = 501 WHERE bot_id = 1 AND user_id = 100",
    ).run();
    const row = await env.HODOR_DB.prepare(
      "SELECT thread_id FROM topics WHERE bot_id = 1 AND user_id = 100",
    ).first<{ thread_id: number }>();
    expect(row?.thread_id).toBe(501);
  });
});

describe("schema: processed_updates 幂等主键", () => {
 it("重复 (bot_id, update_id) 插入被拒", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (1, 9000, 'processed')",
    ).run();
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (1, 9000, 'failed')",
      ).run(),
    ).rejects.toThrow();
  });
});

describe("schema: processed_updates status 三值 CHECK（迁移 0002）", () => {
 it("processing / processed / failed 均可插入；非法值被拒", async () => {
    for (const [i, status] of ["processing", "processed", "failed"].entries()) {
      await env.HODOR_DB.prepare(
        "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (1, ?, ?)",
      )
        .bind(9200 + i, status)
        .run();
    }
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (1, 9999, 'bogus')",
      ).run(),
    ).rejects.toThrow();
  });
});

describe("schema: users 挑战栅栏四列（迁移 0006）", () => {
 it("verify_request_hash / expires_at / generation / submit_not_before 均存在且可空", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO users (bot_id, user_id) VALUES (2, 100)",
    ).run();
 // 默认全 NULL（可空列，无 NOT NULL 约束）
    const row = await env.HODOR_DB.prepare(
      `SELECT verify_request_hash, verify_request_expires_at, verify_request_generation, verify_submit_not_before
       FROM users WHERE bot_id = 2 AND user_id = 100`,
    ).first<{
      verify_request_hash: string | null;
      verify_request_expires_at: string | null;
      verify_request_generation: number | null;
      verify_submit_not_before: string | null;
    }>();
    expect(row).toEqual({
      verify_request_hash: null,
      verify_request_expires_at: null,
      verify_request_generation: null,
      verify_submit_not_before: null,
    });
 // 各列可写入并读回
    await env.HODOR_DB.prepare(
      `UPDATE users SET verify_request_hash = ?, verify_request_expires_at = ?,
         verify_request_generation = ?, verify_submit_not_before = ?
       WHERE bot_id = 2 AND user_id = 100`,
    )
      .bind("a".repeat(64), "2026-10-09T00:10:00.000Z", 3, "2026-10-09T00:00:15.000Z")
      .run();
    const updated = await env.HODOR_DB.prepare(
      "SELECT verify_request_hash, verify_request_generation FROM users WHERE bot_id = 2 AND user_id = 100",
    ).first<{ verify_request_hash: string; verify_request_generation: number }>();
    expect(updated).toEqual({ verify_request_hash: "a".repeat(64), verify_request_generation: 3 });
  });
});

describe("schema: settings 读写冒烟", () => {
 it("INSERT → UPDATE → SELECT 往返取到更新后的值", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('verify_enabled', '1')",
    ).run();
    await env.HODOR_DB.prepare(
      "UPDATE settings SET value = '0' WHERE key = 'verify_enabled'",
    ).run();
    const row = await env.HODOR_DB.prepare(
      "SELECT value FROM settings WHERE key = 'verify_enabled'",
    ).first<{ value: string }>();
    expect(row?.value).toBe("0");
  });
});

describe("schema: broadcasts 约束（迁移 0005）", () => {
  // 部分唯一索引以 bot_id 为维度且文件内 D1 共享——每个用例独占一个 bot，
  // 避免用例间草稿 / sending 占用互相冲突
  const insert = (
    botId: number,
    sourceUpdateId: number,
    status = "preparing",
    overrides: Record<string, number> = {},
  ) => {
    const columns = Object.keys(overrides).map((c) => `, ${c}`);
    const placeholders = Object.keys(overrides).map(() => ", ?").join("");
    return env.HODOR_DB.prepare(
      `INSERT INTO broadcasts (bot_id, source_update_id, initiator_user_id, support_chat_id, message_html, status, expires_at${columns})
       VALUES (?, ?, 9, -100, '<b>x</b>', ?, ?${placeholders})`,
    ).bind(
      botId,
      sourceUpdateId,
      status,
      new Date(Date.now() + 60_000).toISOString(),
      ...Object.values(overrides),
    ).run();
  };

 it("status 非法值被 CHECK 拒绝；七态枚举全部可插入", async () => {
 // 每态独占一个 bot（草稿 / sending 部分唯一索引以 bot 为维度，不能并存）
    for (const [i, status] of [
      "preparing",
      "pending",
      "sending",
      "completed",
      "cancelled",
      "expired",
      "failed",
    ].entries()) {
      await insert(101 + i, 1000 + i, status);
    }
    await expect(insert(199, 2000, "bogus")).rejects.toThrow();
  });

 it("计数 CHECK 非负：负数 expected/success/failure 被拒", async () => {
    await expect(insert(102, 3001, "preparing", { expected_count: -1 })).rejects.toThrow();
    await expect(insert(102, 3002, "preparing", { success_count: -1 })).rejects.toThrow();
    await expect(insert(102, 3003, "preparing", { failure_count: -1 })).rejects.toThrow();
  });

 it("UNIQUE (bot_id, source_update_id)：同一发起 update 重复插入被拒", async () => {
    await insert(103, 4001);
    await expect(insert(103, 4001)).rejects.toThrow();
 // 其他 bot 同 update_id 不冲突（bot 维度隔离）
    await insert(104, 4001);
  });

 it("部分唯一索引：每 Bot 恰一份 sending、恰一份 preparing/pending 草稿", async () => {
 // sending 唯一：第二份 sending 被拒；终态行并存无碍
    await insert(105, 5001, "sending");
    await expect(insert(105, 5002, "sending")).rejects.toThrow();
    await insert(105, 5003, "completed");
 // 草稿唯一：preparing 与 pending 同占一份（跨状态并存被拒）
    await insert(105, 5004, "preparing");
    await expect(insert(105, 5005, "pending")).rejects.toThrow();
 // sending 与草稿可并存（design：草稿可与发送中任务并存）——需独立 bot
 //（105 已同时占用两份名额）
    await insert(106, 5006, "sending");
    await insert(106, 5007, "preparing");
  });
});
