/**
 * 用户 / 管理员可见文案的唯一集中点（T23 / T24 / T26 + 阶段 4 T27/T29/T34/T35）。
 *
 * fork 可整体改写本模块（含多语言）——除本文件外，任何模块不得散落
 * 硬编码用户文案（PRD 约束）。文案定稿来源：docs/guide/features.md。
 * 带参数的文案一律用 format* 函数（fork 单点改写，调用方零文案）。
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
  /** 验证真值（users.is_verified）：置顶验证行随状态迁移同步（T27/T29） */
  isVerified: boolean;
}

/**
 * 置顶的用户信息（T24 + 阶段 4 验证行两态）：
 * 昵称（含 @username 括注）/ 用户 ID / 首次聊天（截到分钟）/ 验证状态。
 *
 * - 昵称回退链：first+last_name → @username → ID_<id>；括注只在展示名来自
 *   姓名且存在 @username 时携带（否则会与回退名重复）
 * - 验证行两态真值（阶段 4 交付验证起）：isVerified → ✅ 已验证 / ❌ 未验证
 *   （阶段 3 的「未启用」成为历史；答对 / 超限降级时 editMessageText 同步）
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
    `验证状态：${user.isVerified ? "✅ 已验证" : "❌ 未验证"}`,
  ].join("\n");
}

/**
 * 无绑定 topic 提示（T26）：管理员在无映射行 / closed 的 topic 内发言时，
 * 发回该 topic 的提示（绝不发往任何用户私聊）。/ban /unban 无绑定时复用（T35）。
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

/* ------------------------------------------------------------------ */
/* 阶段 4：验证（T27）/ 限频（T29）/ 封禁（T35）/ 命令（T34）文案        */
/* ------------------------------------------------------------------ */

/** 验证题题头（T27）：题面与超限合并消息共用，保证提示语义一致 */
export const VERIFY_QUESTION_HEADER = "为确认你是真人，请回答下面的算术题：";

/** 新题消息正文（T27）：题头 + 算式（expression 如 "3 + 5 = ?"） */
export function formatVerifyQuestion(expression: string): string {
  return `${VERIFY_QUESTION_HEADER}\n${expression}`;
}

/**
 * 答错重出正文（T27）：错误提示 + 新题——编辑到**同一题面消息**
 * （无新推送，天然不占提示频控），expression 为新算式。
 */
export function formatVerifyRetryQuestion(expression: string): string {
  return `回答错误，请再试一次。\n\n${VERIFY_QUESTION_HEADER}\n${expression}`;
}

/** 答错 toast（answerCallbackQuery 弹出，T27） */
export const VERIFY_WRONG_TOAST = "回答错误，请重试。";

/** 答对 toast（answerCallbackQuery 弹出，T27） */
export const VERIFY_PASSED_TOAST = "验证通过！";

/** 答对后题面消息的编辑文案（原位替换题面，T27） */
export const VERIFY_PASSED_TEXT = "✅ 验证通过，现在可以直接发送消息了。";

/** 旧题 / 他人 / 重放回调 toast（T27 归属判定拦截时弹出） */
export const VERIFY_EXPIRED_NOTICE = "题目已失效，请发送任意消息获取新题目。";

/**
 * 超限合并消息正文（T29）：限频提示（含 {limit} 数字）+ 新题，
 * 单条 push 发出（提示 + 题面 + 按钮同消息，只占一次提示频控）。
 */
export function formatRateLimitVerifyQuestion(limit: number, expression: string): string {
  return `发送过快，每分钟最多 ${limit} 条消息，本条未送达。请重新完成验证：\n\n${VERIFY_QUESTION_HEADER}\n${expression}`;
}

/** 禁言提示（T35）：封禁门拦截用户消息时经提示频控发给用户 */
export const BAN_NOTICE = "你已被禁言，消息无法送达客服。如有疑问请通过其他方式联系。";

/**
 * /help 文案（T34）：只列**已交付**命令（阶段 4：/help /ban /unban）；
 * 后续阶段新增命令时在此增行，未交付命令绝不提前展示。
 */
export const HELP_TEXT = `可用命令：
/help - 显示本帮助
/ban - 禁言当前话题对应用户
/unban - 解除当前话题对应用户的禁言

说明：以 / 开头的消息不会中继给用户。`;

/** 未知命令提示（T34）：回 topic 引导管理员查看 /help，绝不发用户 */
export const UNKNOWN_COMMAND_NOTICE = "未知命令，发送 /help 查看可用命令。";

/**
 * 非管理员命令提示（T34 真机验收增量，2026-09-30）：非管理员在客服群
 * topic 内发 `/` 命令时回发该 topic（原为静默——用户验收时要求可见反馈；
 * 非命令文本仍静默）。回 topic 不触达任何用户私聊。
 */
export const NOT_ADMIN_COMMAND_NOTICE = "该命令仅客服管理员可用。";

/**
 * 管理命令菜单（T34 真机验收增量，2026-09-30）：setwebhook 时经
 * setMyCommands 注册进 Telegram 命令菜单（客服群输入框可直接点选，不用
 * 手敲）。scope 恒为客服群 chat——用户私聊菜单不受影响。command 一律
 * 小写无斜杠（Telegram BotCommand 规范）；阶段 5 新命令在此扩展，
 * 并与 HELP_TEXT 的「已交付命令」清单保持同步。
 */
export const ADMIN_COMMAND_MENU: readonly { command: string; description: string }[] = [
  { command: "help", description: "查看管理命令帮助" },
  { command: "ban", description: "封禁本话题用户" },
  { command: "unban", description: "解封本话题用户" },
];

/** /ban 确认（T35）：回 topic，携带目标用户 ID 便于管理员核对 */
export function formatBanConfirmed(userId: number): string {
  return `已禁言用户 ${userId}：其后续消息将被拦截。`;
}

/** /unban 确认（T35）：回 topic */
export function formatUnbanConfirmed(userId: number): string {
  return `已解除用户 ${userId} 的禁言。`;
}
