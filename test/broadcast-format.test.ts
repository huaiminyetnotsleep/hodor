/**
 * 广播公告组装纯函数直测（全用户广播）：
 * parseBroadcastInput（标题/正文拆分、CRLF 归一化、必填校验）+ composeBroadcast
 * （HTML 转义防注入、冻结产物同构、UTF-16 ≤4096 保守校验）。零 IO，
 * Gate B 的核心证明面：特殊字符不能注入 HTML。
 */
import { describe, expect, it } from "vitest";
import {
  BROADCAST_MAX_VISIBLE_LENGTH,
  composeBroadcast,
  escapeHtml,
  parseBroadcastInput,
} from "../src/pipeline/broadcastFormat";

describe("broadcastFormat: parseBroadcastInput", () => {
 it("标准输入：首行命令后为标题，其余为正文（内部空行保留）", () => {
    expect(
      parseBroadcastInput("/broadcast 系统维护通知\n\n今晚 23:00–23:30 进行系统维护。\n\n恢复后尽快处理。"),
    ).toEqual({
      title: "系统维护通知",
      body: "今晚 23:00–23:30 进行系统维护。\n\n恢复后尽快处理。",
    });
  });

 it("@botname 后缀命令同解析；命令与标题间多空白容忍", () => {
    expect(parseBroadcastInput("/broadcast@hodor_bot   标题  \n正文")).toEqual({
      title: "标题",
      body: "正文",
    });
  });

 it("CRLF 归一化为 LF；首尾空白 trim、正文内部空白不动", () => {
    expect(parseBroadcastInput("/broadcast 标题\r\n\r\n第一段\r\n\r\n第二段  \r\n")).toEqual({
      title: "标题",
      body: "第一段\n\n第二段",
    });
  });

 it("空标题 / 空正文 / 无正文 / 缺失 → null（二者均必填）", () => {
    expect(parseBroadcastInput(undefined)).toBeNull();
    expect(parseBroadcastInput("/broadcast")).toBeNull();
    expect(parseBroadcastInput("/broadcast   \n正文")).toBeNull();
    expect(parseBroadcastInput("/broadcast 标题")).toBeNull();
    expect(parseBroadcastInput("/broadcast 标题\n   ")).toBeNull();
    expect(parseBroadcastInput("/broadcast 标题\n\n")).toBeNull();
  });

 it("正文中的 Markdown / HTML 符号按普通文字拆分，不做解释", () => {
    expect(parseBroadcastInput("/broadcast *标题*\n<b>正文</b> 与 * _ 字符")).toEqual({
      title: "*标题*",
      body: "<b>正文</b> 与 * _ 字符",
    });
  });
});

describe("broadcastFormat: escapeHtml", () => {
 it("仅转义 & < >，引号与中文原样", () => {
    expect(escapeHtml('a & b < c > d "e" 引号')).toBe("a &amp; b &lt; c &gt; d \"e\" 引号");
  });
});

describe("broadcastFormat: composeBroadcast", () => {
 it("冻结产物：HTML 标签系统生成，标题加粗、落款斜体、正文换行保留", () => {
    const composed = composeBroadcast("维护通知", "第一行\n第二行", "Hodor");
    expect(composed).not.toBeNull();
    expect(composed!.messageHtml).toBe(
      "<b>📣 维护通知</b>\n\n第一行\n第二行\n\n<i>— Hodor</i>",
    );
    expect(composed!.plainText).toBe("📣 维护通知\n\n第一行\n第二行\n\n— Hodor");
  });

 it("防注入（AC4）：正文中的 & < > 与类标签输入按原文字面转义，绝不解释为 HTML", () => {
    const composed = composeBroadcast("T & 标题", "<script>alert(1)</script> & <b>不是标签</b>", "Bot <1>");
    expect(composed!.messageHtml).toBe(
      "<b>📣 T &amp; 标题</b>\n\n" +
        "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;不是标签&lt;/b&gt;\n\n" +
        "<i>— Bot &lt;1&gt;</i>",
    );
 // 纯文本视图与去标签后的 HTML 逐字一致（同构）
    const stripped = composed!.messageHtml
      .replace(/<b>|<\/b>|<i>|<\/i>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    expect(stripped).toBe(composed!.plainText);
  });

 it("emoji 与多字节字符保留（📣 头、正文内 emoji）", () => {
    const composed = composeBroadcast("🎉 上线", "含 emoji 🚀 的正文", "Hodor");
    expect(composed!.plainText).toContain("🎉 上线");
    expect(composed!.plainText).toContain("🚀");
  });

 it("长度校验：最终可见纯文本 ≤4096 UTF-16 code units；超限返回 null（不截断不拆分）", () => {
 // 精确边界：固定开销（📣 为非 BMP 计 2 + 分隔换行 + 落款）= 14，标题 1
    const fixedOverhead = "📣 \n\n\n\n— Hodor".length;
    const titleBudget = "t".length;
    const maxBody = BROADCAST_MAX_VISIBLE_LENGTH - fixedOverhead - titleBudget;
    const atLimit = composeBroadcast("t", "b".repeat(maxBody), "Hodor");
    expect(atLimit).not.toBeNull();
    expect(atLimit!.plainText.length).toBe(BROADCAST_MAX_VISIBLE_LENGTH);
 // 再加一个字符即越界 → null；解析层保留原文（拒绝而非截断）
    const tooLong = composeBroadcast("t", "b".repeat(maxBody + 1), "Hodor");
    expect(tooLong).toBeNull();
  });

 it("超长按 UTF-16 计数：非 BMP emoji 每个计 2 个 code unit（保守口径）", () => {
 // "𝄞"（U+1D11E）UTF-16 长度为 2；构造 4096 个即 8192 code units → 超限
    const longEmoji = "𝄞".repeat(2048);
    expect(longEmoji.length).toBe(4096);
    expect(composeBroadcast("t", longEmoji, "Hodor")).toBeNull();
  });
});
