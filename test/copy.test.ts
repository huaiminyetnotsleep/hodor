/**
 * copy.ts 文案模块直测（trellis-check P2 加固，2026-09-30）：
 *
 * - DEFAULT_WELCOME_TEXT 逐字定稿——期望值**硬编码**（不取自 copy.ts），
 *   打破「import 常量自比较」的循环断言：文案漂移（fork 改写 / 误改）即刻红灯；
 * - formatPinnedInfo 回退链三分支完整输出 + 恒含「验证状态：未启用」与
 *   `YYYY-MM-DD HH:mm (UTC)` 时间格式（阶段 4 验证上线前绝不伪称已验证）；
 * - isStartCommand 矩阵（content.test.ts 只测 extractContent，本矩阵此前
 *   仅有 inbound 端到端覆盖，此处直测定稿）。
 *
 * 纯函数直测，不触碰 D1 与 SELF。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WELCOME_TEXT, formatPinnedInfo, isStartCommand } from "../src/copy";

describe("copy: DEFAULT_WELCOME_TEXT 逐字定稿", () => {
  it("三要素完整字面量（项目名 / 使用方式 / 项目地址；emoji、空行、URL 均逐字）", () => {
    // 期望值硬编码自 docs/guide/features.md 定稿文案——与 copy.ts 零共享
    expect(DEFAULT_WELCOME_TEXT).toBe(`你好，欢迎使用 hodor 私聊机器人！👋

直接发送消息即可与客服对话，无需任何命令；客服的回复也会在这里显示。

项目地址：https://github.com/huaiminyetnotsleep/hodor`);
  });
});

describe("copy: formatPinnedInfo 昵称回退链（完整输出断言）", () => {
  it("first + last 且有 @username：姓名（@handle）括注齐备", () => {
    expect(
      formatPinnedInfo({
        id: 123456789,
        first_name: "张",
        last_name: "三",
        username: "zhangsan",
        firstSeenAt: "2026-09-29T18:00:05.123Z",
      }),
    ).toBe(
      [
        "昵称：张 三（@zhangsan）",
        "用户 ID：123456789",
        "首次聊天：2026-09-29 18:00 (UTC)",
        "验证状态：未启用",
      ].join("\n"),
    );
  });

  it("姓名无 @username：括注整体省略（不留空括号）", () => {
    expect(
      formatPinnedInfo({
        id: 42,
        first_name: "Alice",
        last_name: "L",
        firstSeenAt: "2020-01-01T08:05:00.000Z",
      }),
    ).toBe(
      [
        "昵称：Alice L",
        "用户 ID：42",
        "首次聊天：2020-01-01 08:05 (UTC)",
        "验证状态：未启用",
      ].join("\n"),
    );
  });

  it("全无名（first_name 空白同缺席）但有 @username → 展示 @username 且括注省略（不出现 @x（@x）重复）", () => {
    expect(
      formatPinnedInfo({
        id: 778,
        first_name: "   ",
        username: "bob_hd",
        firstSeenAt: "2024-12-31T23:59:59.999Z",
      }),
    ).toBe(
      [
        "昵称：@bob_hd",
        "用户 ID：778",
        "首次聊天：2024-12-31 23:59 (UTC)",
        "验证状态：未启用",
      ].join("\n"),
    );
  });

  it("全无名无 @username → ID_<id> 兜底", () => {
    expect(
      formatPinnedInfo({ id: 777, firstSeenAt: "2025-06-30T09:07:00.000Z" }),
    ).toBe(
      [
        "昵称：ID_777",
        "用户 ID：777",
        "首次聊天：2025-06-30 09:07 (UTC)",
        "验证状态：未启用",
      ].join("\n"),
    );
  });

  it("任意分支恒含「验证状态：未启用」且时间为 YYYY-MM-DD HH:mm (UTC)（秒/毫秒截断）", () => {
    const samples = [
      formatPinnedInfo({ id: 1, first_name: "A", username: "a", firstSeenAt: "2026-09-29T18:00:05.123Z" }),
      formatPinnedInfo({ id: 2, first_name: "B", firstSeenAt: "2026-09-29T18:00:05.123Z" }),
      formatPinnedInfo({ id: 3, username: "c", firstSeenAt: "2026-09-29T18:00:05.123Z" }),
      formatPinnedInfo({ id: 4, firstSeenAt: "2026-09-29T18:00:05.123Z" }),
    ];
    for (const text of samples) {
      expect(text).toContain("验证状态：未启用");
      expect(text).toMatch(/首次聊天：\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC\)/);
      expect(text).not.toContain("已验证");
    }
  });
});

describe("copy: isStartCommand 矩阵", () => {
  it("命令形态 ✓：/start、/start@bot、/start payload、/start@bot payload、尾随空白", () => {
    expect(isStartCommand("/start")).toBe(true);
    expect(isStartCommand("/start@hodor_bot")).toBe(true);
    expect(isStartCommand("/start payload")).toBe(true);
    expect(isStartCommand("/start@hodor_bot payload")).toBe(true);
    expect(isStartCommand("/start ")).toBe(true);
  });

  it("非命令形态 ✗：前缀巧合 / 其他命令 / 空串 / 缺失 / 大小写敏感", () => {
    expect(isStartCommand("/startx")).toBe(false);
    expect(isStartCommand("/help")).toBe(false);
    expect(isStartCommand("")).toBe(false);
    expect(isStartCommand(undefined)).toBe(false);
    expect(isStartCommand("/START")).toBe(false);
  });
});
