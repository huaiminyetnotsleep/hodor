/**
 * copy.ts 文案模块直测（trellis-check P2 加固，2026-09-30）：
 *
 * - DEFAULT_WELCOME_TEXT 逐字定稿——期望值**硬编码**（不取自 copy.ts），
 *   打破「import 常量自比较」的循环断言：文案漂移（fork 改写 / 误改）即刻红灯；
 * - formatPinnedInfo 回退链三分支完整输出 + 验证行**两态真值**与
 *   `YYYY-MM-DD HH:mm (UTC)` 时间格式；
 * - isStartCommand 矩阵；阶段 4 新文案定稿（验证题 / 超限 / 禁言 / 命令）。
 *
 * 纯函数直测，不触碰 D1 与 SELF。
 *
 * 阶段 4 调整说明：阶段 3 的「验证状态：未启用」断言按验证交付翻转为两态
 * 契约（isVerified → ✅ 已验证 / ❌ 未验证）——原断言意图（置顶绝不伪称
 * 验证状态）保留并收紧为「恒为两态真值之一，且不再出现『未启用』」。
 */
import { describe, expect, it } from "vitest";
import {
  BAN_NOTICE,
  DEFAULT_WELCOME_TEXT,
  formatBanConfirmed,
  formatPinnedInfo,
  formatRateLimitVerifyQuestion,
  formatUnbanConfirmed,
  formatVerifyQuestion,
  formatVerifyRetryQuestion,
  HELP_TEXT,
  isStartCommand,
  UNBOUND_TOPIC_NOTICE,
  UNKNOWN_COMMAND_NOTICE,
  VERIFY_EXPIRED_NOTICE,
  VERIFY_PASSED_TEXT,
  VERIFY_PASSED_TOAST,
  VERIFY_QUESTION_HEADER,
  VERIFY_WRONG_TOAST,
} from "../src/copy";

describe("copy: DEFAULT_WELCOME_TEXT 逐字定稿", () => {
  it("三要素完整字面量（项目名 / 使用方式 / 项目地址；emoji、空行、URL 均逐字）", () => {
    // 期望值硬编码自 docs/guide/features.md 定稿文案——与 copy.ts 零共享
    expect(DEFAULT_WELCOME_TEXT).toBe(`你好，欢迎使用 hodor 私聊机器人！👋

直接发送消息即可与客服对话，无需任何命令；客服的回复也会在这里显示。

项目地址：https://github.com/huaiminyetnotsleep/hodor`);
  });
});

describe("copy: formatPinnedInfo 昵称回退链与验证行两态（完整输出断言）", () => {
  it("first + last 且有 @username：姓名（@handle）括注齐备（已验证态 ✅）", () => {
    expect(
      formatPinnedInfo({
        id: 123456789,
        first_name: "张",
        last_name: "三",
        username: "zhangsan",
        firstSeenAt: "2026-09-29T18:00:05.123Z",
        isVerified: true,
      }),
    ).toBe(
      [
        "昵称：张 三（@zhangsan）",
        "用户 ID：123456789",
        "首次聊天：2026-09-29 18:00 (UTC)",
        "验证状态：✅ 已验证",
      ].join("\n"),
    );
  });

  it("姓名无 @username：括注整体省略（不留空括号）（未验证态 ❌）", () => {
    expect(
      formatPinnedInfo({
        id: 42,
        first_name: "Alice",
        last_name: "L",
        firstSeenAt: "2020-01-01T08:05:00.000Z",
        isVerified: false,
      }),
    ).toBe(
      [
        "昵称：Alice L",
        "用户 ID：42",
        "首次聊天：2020-01-01 08:05 (UTC)",
        "验证状态：❌ 未验证",
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
        isVerified: false,
      }),
    ).toBe(
      [
        "昵称：@bob_hd",
        "用户 ID：778",
        "首次聊天：2024-12-31 23:59 (UTC)",
        "验证状态：❌ 未验证",
      ].join("\n"),
    );
  });

  it("全无名无 @username → ID_<id> 兜底（已验证态 ✅）", () => {
    expect(
      formatPinnedInfo({ id: 777, firstSeenAt: "2025-06-30T09:07:00.000Z", isVerified: true }),
    ).toBe(
      [
        "昵称：ID_777",
        "用户 ID：777",
        "首次聊天：2025-06-30 09:07 (UTC)",
        "验证状态：✅ 已验证",
      ].join("\n"),
    );
  });

  it("任意分支恒含两态验证行且时间为 YYYY-MM-DD HH:mm (UTC)（秒/毫秒截断；不再出现「未启用」）", () => {
    const samples = [
      formatPinnedInfo({ id: 1, first_name: "A", username: "a", firstSeenAt: "2026-09-29T18:00:05.123Z", isVerified: false }),
      formatPinnedInfo({ id: 2, first_name: "B", firstSeenAt: "2026-09-29T18:00:05.123Z", isVerified: false }),
      formatPinnedInfo({ id: 3, username: "c", firstSeenAt: "2026-09-29T18:00:05.123Z", isVerified: false }),
      formatPinnedInfo({ id: 4, firstSeenAt: "2026-09-29T18:00:05.123Z", isVerified: false }),
    ];
    for (const text of samples) {
      expect(text).toContain("验证状态：❌ 未验证");
      expect(text).toMatch(/首次聊天：\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC\)/);
      // 未验证态绝不混入已验证标记；两态契约下「未启用」成为历史
      expect(text).not.toContain("✅");
      expect(text).not.toContain("未启用");
    }
    // 已验证态：✅ 已验证（与未验证态零歧义）
    expect(
      formatPinnedInfo({ id: 5, first_name: "V", firstSeenAt: "2026-01-01T00:00:00.000Z", isVerified: true }),
    ).toContain("验证状态：✅ 已验证");
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

describe("copy: 阶段 4 验证 / 限频文案（T27/T29）", () => {
  it("formatVerifyQuestion：题头 + 算式，题头与超限形态共用", () => {
    expect(formatVerifyQuestion("3 + 5 = ?")).toBe(`${VERIFY_QUESTION_HEADER}\n3 + 5 = ?`);
  });

  it("formatVerifyRetryQuestion：错误提示在前 + 空行 + 新题（同一消息原位重出）", () => {
    expect(formatVerifyRetryQuestion("8 - 2 = ?")).toBe(
      `回答错误，请再试一次。\n\n${VERIFY_QUESTION_HEADER}\n8 - 2 = ?`,
    );
  });

  it("formatRateLimitVerifyQuestion：文案含限频数字（验收断言点「3」）+ 新题", () => {
    const text = formatRateLimitVerifyQuestion(3, "4 + 4 = ?");
    expect(text).toContain("每分钟最多 3 条");
    expect(text).toContain(`${VERIFY_QUESTION_HEADER}\n4 + 4 = ?`);
    // 其他 limit 数值同样内插（不与 3 硬编码耦合）
    expect(formatRateLimitVerifyQuestion(20, "1 + 1 = ?")).toContain("每分钟最多 20 条");
  });

  it("toast / 编辑文案定稿（硬编码，防漂移）", () => {
    expect(VERIFY_WRONG_TOAST).toBe("回答错误，请重试。");
    expect(VERIFY_PASSED_TOAST).toBe("验证通过！");
    expect(VERIFY_PASSED_TEXT).toBe("✅ 验证通过，现在可以直接发送消息了。");
    expect(VERIFY_EXPIRED_NOTICE).toBe("题目已失效，请发送任意消息获取新题目。");
  });
});

describe("copy: 阶段 4 封禁与命令文案（T34/T35）", () => {
  it("BAN_NOTICE 定稿：明确告知禁言且不留绕过暗示", () => {
    expect(BAN_NOTICE).toBe("你已被禁言，消息无法送达客服。如有疑问请通过其他方式联系。");
  });

  it("HELP_TEXT 只列已交付命令（/help /ban /unban）并说明 / 开头不中继；不含未交付命令", () => {
    expect(HELP_TEXT).toContain("/help");
    expect(HELP_TEXT).toContain("/ban");
    expect(HELP_TEXT).toContain("/unban");
    expect(HELP_TEXT).toContain("不会中继");
    // 阶段 5-6 命令绝不提前出现（只展示已交付）
    expect(HELP_TEXT).not.toContain("/deluser");
    expect(HELP_TEXT).not.toContain("/purgemsg");
    expect(HELP_TEXT).not.toContain("/wipealldata");
    expect(HELP_TEXT).not.toContain("/note");
  });

  it("UNKNOWN_COMMAND_NOTICE 引导 /help", () => {
    expect(UNKNOWN_COMMAND_NOTICE).toBe("未知命令，发送 /help 查看可用命令。");
  });

  it("ban / unban 确认携带目标用户 ID", () => {
    expect(formatBanConfirmed(7117077829)).toBe("已禁言用户 7117077829：其后续消息将被拦截。");
    expect(formatUnbanConfirmed(7117077829)).toBe("已解除用户 7117077829 的禁言。");
  });

  it("UNBOUND_TOPIC_NOTICE 定稿不变（/ban /unban 无绑定复用）", () => {
    expect(UNBOUND_TOPIC_NOTICE).toBe(
      "找不到对应用户：此话题没有有效绑定（可能从未建立或已被关闭），请勿在此继续回复。",
    );
  });
});
