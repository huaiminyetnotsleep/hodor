/**
 * 用户可见文案的唯一集中点（T23 / T24 / T26）。
 *
 * fork 可整体改写本模块（含多语言）——除本文件外，任何模块不得散落
 * 硬编码用户文案（PRD 约束）。文案定稿来源：docs/guide/features.md。
 */

/**
 * 默认欢迎语文案（features.md 定稿，三要素逐字一致：项目名称 / 使用方式 / 项目地址）。
 *
 * 可用环境变量 WELCOME_TEXT 整体覆盖（env.ts parseWelcomeText 解析，字面 \n
 * 解释为换行）；缺失 / 为空时兜底使用本默认文案。
 */
export const DEFAULT_WELCOME_TEXT = `你好，欢迎使用 hodor 私聊机器人！👋

直接发送消息即可与客服对话，无需任何命令；客服的回复也会在这里显示。

项目地址：https://github.com/huaiminyetnotsleep/hodor`;

/** formatPinnedInfo 所需的用户字段子集（users 行展示列 + 建档时间） */
export interface PinnedInfoUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  /** users.first_seen_at（ISO-8601 UTC 文本） */
  firstSeenAt: string;
}

/**
 * 置顶的用户信息（T24）：
 * 昵称（含 @username 括注）/ 用户 ID / 首次聊天（截到分钟）/ 验证状态。
 *
 * - 昵称回退链：first+last_name → @username → ID_<id>；括注只在展示名来自
 *   姓名且存在 @username 时携带（否则会与回退名重复）
 * - 验证状态恒为「未启用」：验证功能阶段 4 才交付，绝不伪称已验证
 * - 高危 / 备注行阶段 5 起才展示（阶段边界）
 * - firstSeenAt 为 ISO 文本截到分钟（`YYYY-MM-DD HH:mm`）：D1 默认值与
 *   nowIso() 同构（`YYYY-MM-DDTHH:mm:ss.sssZ`），前 16 位切片即所需
 */
export function formatPinnedInfo(user: PinnedInfoUser): string {
  const names = [user.first_name?.trim(), user.last_name?.trim()].filter(
    (name): name is string => name !== undefined && name !== "",
  );
  const fromNames = names.length > 0 ? names.join(" ") : undefined;
  const displayName =
    fromNames ?? (user.username ? `@${user.username}` : `ID_${user.id}`);
  const handle = fromNames && user.username ? `（@${user.username}）` : "";
  const firstSeen = `${user.firstSeenAt.slice(0, 10)} ${user.firstSeenAt.slice(11, 16)}`;
  return [
    `昵称：${displayName}${handle}`,
    `用户 ID：${user.id}`,
    `首次聊天：${firstSeen} (UTC)`,
    "验证状态：未启用",
  ].join("\n");
}

/**
 * 无绑定 topic 提示（T26）：管理员在无映射行 / closed 的 topic 内发言时，
 * 发回该 topic 的提示（绝不发往任何用户私聊）。
 */
export const UNBOUND_TOPIC_NOTICE =
  "找不到对应用户：此话题没有有效绑定（可能从未建立或已被关闭），请勿在此继续回复。";

/**
 * /start 命令判定（T23）：`/start` 本身、`/start@bot`、`/start payload` 均算；
 * `/startups` 这类前缀巧合不算。undefined / 非命令 → false。
 */
export function isStartCommand(text: string | undefined): boolean {
  if (text === "/start") return true;
  return /^\/start(@\S+)?(\s|$)/.test(text ?? "");
}
