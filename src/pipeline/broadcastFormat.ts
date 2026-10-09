/**
 * 广播公告组装纯函数（全用户广播，2026-10-09 任务）：/broadcast 输入解析、
 * 安全 HTML 组装与最终可见文本长度校验。零 IO、零 Telegram / D1 依赖，
 * 行为完全由单测固化（test/broadcast-format.test.ts）。
 *
 * 格式契约（PRD R5 / design §四）：
 *
 *   <b>📣 {标题}</b>
 *
 *   {正文（保留原始换行与空行）}
 *
 *   <i>— {落款}</i>
 *
 * - 标题 / 正文 / 落款中的 `& < >` 一律转义——管理员输入永远不作为 HTML
 *   标签解释（正文中的 `*`、`_`、`<` 按原文字面展示，AC4）。
 * - 普通中继继续纯文本（不开全局 parse_mode）；本模块只服务广播。
 * - 长度校验针对**最终可见纯文本**的 UTF-16 code unit 数（保守口径，
 *   design §四.3）：超限拒绝，不截断、不拆分。
 */

/** Telegram sendMessage 文本上限（after entities parsing，官方契约） */
export const BROADCAST_MAX_VISIBLE_LENGTH = 4096;

/** 组装产物：冻结 HTML（预览与逐位发送共用）+ 同构纯文本（长度校验与测试锚点） */
export interface BroadcastComposition {
  title: string;
  body: string;
  /** 已转义、冻结的最终公告（sendMessage text + parse_mode HTML） */
  messageHtml: string;
  /** 与 messageHtml 同构的纯可见文本（去标签后逐字一致） */
  plainText: string;
}

/** HTML 特殊字符转义（`& < >`；引号在纯文本节点中无需转义） */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 解析 `/broadcast` 输入（PRD R7）：第一行命令后的内容为标题，其余为正文，
 * 二者均必填。
 *
 * - 命令 token（`/broadcast` 或 `/broadcast@botname`）后到首个换行前 trim
 *   后为标题；
 * - 正文统一 CRLF 为 LF，trim 首尾，内部空行保留；
 * - 标题或正文为空 → null（调用方回用法提示）。
 */
export function parseBroadcastInput(
  text: string | undefined,
): { title: string; body: string } | null {
  if (text === undefined) return null;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstNewline = normalized.indexOf("\n");
  const firstLine = (firstNewline === -1 ? normalized : normalized.slice(0, firstNewline)).trim();
  // 去掉首 token（命令本身，可带 @botname 后缀）得到标题
  const title = firstLine.replace(/^\S+\s*/, "").trim();
  const body = firstNewline === -1 ? "" : normalized.slice(firstNewline + 1).trim();
  if (title === "" || body === "") return null;
  return { title, body };
}

/**
 * 组装最终公告。最终可见纯文本超过 4096 UTF-16 code unit → null
 * （超长拒绝：不截断、不拆分，调用方提示修改）。
 */
export function composeBroadcast(
  title: string,
  body: string,
  signature: string,
): BroadcastComposition | null {
  const plainText = `📣 ${title}\n\n${body}\n\n— ${signature}`;
  if (plainText.length > BROADCAST_MAX_VISIBLE_LENGTH) return null;
  const messageHtml = `<b>📣 ${escapeHtml(title)}</b>\n\n${escapeHtml(body)}\n\n<i>— ${escapeHtml(signature)}</i>`;
  return { title, body, messageHtml, plainText };
}
