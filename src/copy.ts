/**
 * 用户 / 管理员可见文案的唯一集中点。
 *
 * fork 可整体改写本模块（含多语言）——除本文件外，任何模块不得散落
 * 硬编码用户文案。文案定稿来源：docs/guide/features.md。
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

/** 置顶验证行的三态 */
export type PinnedVerifyState = "verified" | "unverified" | "disabled";

/** formatPinnedInfo 所需的用户字段子集（users 行展示列 + 建档时间 + 治理行） */
export interface PinnedInfoUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  /** users.first_seen_at（ISO-8601 UTC 文本） */
  firstSeenAt: string;
  /**
   * 验证行三态：verified / unverified 按库内真值（users.is_verified），
   * disabled = 验证开关关闭期间（恒「未启用」，覆盖真值——此时无从谈验证状态）
   */
  verify: PinnedVerifyState;
  /** 高危标记（users.is_risk）：true → 追加「高危：⚠️ 高危用户」行 */
  isRisk?: boolean;
  /** 管理员备注（topics.note）：非空 → 追加「备注：<text>」行 */
  note?: string | null;
}

/** 三态验证行文案（disabled 无 emoji——验证未启用时绝不伪称任何状态） */
const VERIFY_STATUS_TEXT: Record<PinnedVerifyState, string> = {
  verified: "✅ 已验证",
  unverified: "❌ 未验证",
  disabled: "未启用",
};

/**
 * 置顶的用户信息：
 * 昵称（含 @username 括注）/ 用户 ID / 首次聊天（截到分钟）/ 验证状态
 * （三态）/ 高危（仅 isRisk）/ 备注（仅非空）。
 *
 * - 昵称回退链：first+last_name → @username → ID_<id>；括注只在展示名来自
 *   姓名且存在 @username 时携带（否则会与回退名重复）
 * - 验证行三态：✅ 已验证 / ❌ 未验证 / 未启用
 *   （开关关闭期间恒「未启用」；答对 / 超限降级 / TTL 过期时 editMessageText 同步）
 * - 高危行仅 isRisk=true 时出现（`高危：⚠️ 高危用户`）；备注行仅 note 非空
 *   时出现——两行都在验证行之后，行序固定
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
  const lines = [
    `昵称：${displayName}${handle}`,
    `用户 ID：${user.id}`,
    `首次聊天：${firstSeen} (UTC)`,
    `验证状态：${VERIFY_STATUS_TEXT[user.verify]}`,
  ];
  if (user.isRisk) lines.push("高危：⚠️ 高危用户");
  const note = user.note?.trim();
  if (note) lines.push(`备注：${user.note}`);
  return lines.join("\n");
}

/**
 * 无绑定 topic 提示：管理员在无映射行 / closed 的 topic 内发言时，
 * 发回该 topic 的提示（绝不发往任何用户私聊）。/ban /unban 无绑定时复用。
 */
export const UNBOUND_TOPIC_NOTICE =
  "找不到对应用户：此话题没有有效绑定（可能从未建立或已被关闭），请勿在此继续回复。";

/**
 * /start 命令判定：`/start` 本身、`/start@bot`、`/start payload` 均算；
 * `/startups` 这类前缀巧合不算。undefined / 非命令 → false。
 */
export function isStartCommand(text: string | undefined): boolean {
  if (text === "/start") return true;
  return /^\/start(@\S+)?(\s|$)/.test(text ?? "");
}

/**
 * /broadcast 命令判定（全用户广播）：`/broadcast` 本身、`/broadcast@bot`、
 * 带参数形态均算；`/broadcasts` 这类前缀巧合不算。undefined / 非命令 → false。
 * 仅客服群 General（无 message_thread_id）由 classify 据此分流到广播管线。
 */
export function isBroadcastCommand(text: string | undefined): boolean {
  if (text === "/broadcast") return true;
  return /^\/broadcast(@\S+)?(\s|$)/.test(text ?? "");
}

/**
 * General 全局命令判定：客服群 General（无
 * message_thread_id）放行、可进入 outbound 命令管线的命令——全局配置命令
 * /verifyon /verifyoff /verifymode /verifymode_math /verifymode_button
 * /verifymode_turnstile 与 /help。/cmd、/cmd@bot、/cmd 参数 均算；
 * /verifymodes、/helpx 这类前缀巧合不算。绑定类命令（/ban /note 等）与
 * 普通消息不放行——General 无绑定语义、不参与中继。
 */
const GENERAL_GLOBAL_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "verifyon",
  "verifyoff",
  "verifymode",
  "verifymode_math",
  "verifymode_button",
  "verifymode_turnstile",
  "help",
]);

export function isGeneralGlobalCommand(text: string | undefined): boolean {
  const firstToken = text?.split(/\s+/)[0] ?? "";
  if (!firstToken.startsWith("/")) return false;
  const at = firstToken.indexOf("@");
  const name = (at === -1 ? firstToken : firstToken.slice(0, at)).slice(1);
  return GENERAL_GLOBAL_COMMAND_NAMES.has(name);
}

/* ------------------------------------------------------------------ */
/* 验证 / 限频 / 封禁 / 命令提示文案                                       */
/* ------------------------------------------------------------------ */

/** 验证题题头：题面与超限合并消息共用，保证提示语义一致 */
export const VERIFY_QUESTION_HEADER = "为确认你是真人，请回答下面的算术题：";

/** 新题消息正文：题头 + 算式（expression 如 "3 + 5 = ?"） */
export function formatVerifyQuestion(expression: string): string {
  return `${VERIFY_QUESTION_HEADER}\n${expression}`;
}

/**
 * 答错重出的错误提示前缀：与 buildChallenge 产出的
 * 模式化题面拼接成重出正文（编辑到**同一题面消息**——无新推送，天然不占
 * 提示频控）。math 模式下拼接产物与下方 formatVerifyRetryQuestion 逐字一致。
 */
export const VERIFY_RETRY_PREFIX = "回答错误，请再试一次。\n\n";

/**
 * 答错重出正文（math 模式）：错误提示 + 新题（题头 + 算式）。
 */
export function formatVerifyRetryQuestion(expression: string): string {
  return `${VERIFY_RETRY_PREFIX}${formatVerifyQuestion(expression)}`;
}

/** 答错 toast（answerCallbackQuery 弹出） */
export const VERIFY_WRONG_TOAST = "回答错误，请重试。";

/** 答对 toast（answerCallbackQuery 弹出） */
export const VERIFY_PASSED_TOAST = "验证通过！";

/** 答对后题面消息的编辑文案（原位替换题面） */
export const VERIFY_PASSED_TEXT = "✅ 验证通过，现在可以直接发送消息了。";

/** 旧题 / 他人 / 重放回调 toast（归属判定拦截时弹出） */
export const VERIFY_EXPIRED_NOTICE = "题目已失效，请发送任意消息获取新题目。";

/**
 * 超限合并消息正文：限频提示（含 {limit} 数字）+ 新题，
 * 单条 push 发出（提示 + 题面 + 按钮同消息，只占一次提示频控）。
 */
export function formatRateLimitVerifyQuestion(limit: number, expression: string): string {
  return `发送过快，每分钟最多 ${limit} 条消息，本条未送达。请重新完成验证：\n\n${VERIFY_QUESTION_HEADER}\n${expression}`;
}

/**
 * 超限合并消息正文——纯按钮模式变体：限频提示前缀与数学题
 * 形态逐字一致（超限语义不随模式变化），题面换为纯按钮引导文案 + 单按钮
 * （按钮本体由 buildChallenge 组装，本函数只管文字）。
 */
export function formatRateLimitVerifyButton(limit: number): string {
  return `发送过快，每分钟最多 ${limit} 条消息，本条未送达。请重新完成验证：\n\n${formatVerifyButtonQuestion()}`;
}

/** 禁言提示：封禁门拦截用户消息时经提示频控发给用户 */
export const BAN_NOTICE = "你已被禁言，消息无法送达客服。如有疑问请通过其他方式联系。";

/**
 * /help 文案：验证段随当前开关与模式动态变化——只展示「可操作的那个」
 * 开关命令（开 → /verifyoff，关 → /verifyon）。
 */
export interface HelpSettings {
  verifyEnabled: boolean;
  verifyMode: "math" | "button" | "turnstile";
}

/** 验证模式的帮助侧中文名（/verifymode 行与切换确认共用） */
export function verifyModeLabel(mode: "math" | "button" | "turnstile"): string {
  return mode === "math" ? "数学题" : mode === "button" ? "纯按钮" : "Turnstile 人机验证";
}

export function formatHelpText(settings: HelpSettings): string {
  const lines = [
    "可用命令：",
    "/help - 显示本帮助",
    "/ban - 禁言当前话题对应用户",
    "/unban - 解除当前话题对应用户的禁言",
    "/note <内容> - 添加用户备注",
    "/unnote - 清除用户备注",
    "/risk - 标记高危用户",
    "/unrisk - 取消高危标记",
    "/broadcast - 向全部用户群发公告（在客服群 General 中使用，需预览确认）",
    "/archive - 软归档当前用户（关闭话题，保留绑定、历史与备注）",
    "/deluser - 物理删除当前用户及群内话题（需二次确认；不删除私聊历史）",
    "/purgemsg - 清理本话题可追踪群消息并重置置顶（话题关闭时先在 Telegram 重开）",
    "",
    "验证：",
  ];
  if (settings.verifyEnabled) {
    // 开 → 唯一可操作的是关（/verifyon 不展示，避免管理员误以为未开）
    lines.push("/verifyoff - 临时关闭人机验证（已验证记录保留）");
  } else {
    lines.push("/verifyon - 开启人机验证", "当前验证已关闭。");
  }
  lines.push(
    `/verifymode - 查看当前验证模式（当前：${verifyModeLabel(settings.verifyMode)}）`,
    "/verifymode_math - 切换到数学题验证",
    "/verifymode_button - 切换到纯按钮验证",
    "/verifymode_turnstile - 切换到 Turnstile 人机验证",
    "验证配置命令仅在客服群 General 中生效；兼容别名 /verifymode math|button|turnstile。",
    "纯按钮模式防护较弱，bot 可直接调 API 点击，仅建议受信任场景使用。",
    "",
    "危险操作：",
    "/wipealldata - 删除全部群内话题并清空全部用户数据（两步确认，不可恢复）",
    "",
    "说明：以 / 开头的消息不会中继给用户。",
  );
  return lines.join("\n");
}

/** 未知命令提示：回 topic 引导管理员查看 /help，绝不发用户 */
export const UNKNOWN_COMMAND_NOTICE = "未知命令，发送 /help 查看可用命令。";

/**
 * 非管理员命令提示：非管理员在客服群
 * topic 内发 `/` 命令时回发该 topic（原为静默——用户验收时要求可见反馈；
 * 非命令文本仍静默）。回 topic 不触达任何用户私聊。
 */
export const NOT_ADMIN_COMMAND_NOTICE = "该命令仅客服管理员可用。";

/**
 * 管理命令菜单：setwebhook 时经
 * setMyCommands 注册进 Telegram 命令菜单（客服群输入框可直接点选，不用
 * 手敲）。scope 恒为客服群 chat——用户私聊菜单不受影响。command 一律
 * 小写无斜杠（Telegram BotCommand 规范）。菜单**恒全量注册**（不随开关
 * 动态变化——Telegram 菜单是客户端缓存，动态化弊大于利；帮助文本才是
 * 动态面），并与 formatHelpText 的「已交付命令」清单保持同步。Telegram
 * BotCommand scope 只到聊天级、无 Topic 级作用域——验证配置命令「仅在
 * General 生效」由 commands.ts 的运行时执行门保证（其他 Topic 回引导提示），
 * 菜单照常全量注册。已部署实例需重跑 setwebhook 刷新菜单。
 */
export const ADMIN_COMMAND_MENU: readonly { command: string; description: string }[] = [
  { command: "help", description: "查看管理命令帮助" },
  { command: "ban", description: "封禁本话题用户" },
  { command: "unban", description: "解封本话题用户" },
  { command: "note", description: "添加用户备注" },
  { command: "unnote", description: "清除用户备注" },
  { command: "risk", description: "标记高危用户" },
  { command: "unrisk", description: "取消高危标记" },
  { command: "verifyon", description: "开启人机验证（General 使用）" },
  { command: "verifyoff", description: "临时关闭人机验证（General 使用）" },
  { command: "verifymode", description: "查看验证模式" },
  { command: "verifymode_math", description: "切到数学题验证" },
  { command: "verifymode_button", description: "切到按钮验证" },
  { command: "verifymode_turnstile", description: "切到 Turnstile 验证" },
  { command: "archive", description: "软归档本话题用户" },
  { command: "deluser", description: "物理删除用户及本话题（需确认）" },
  { command: "purgemsg", description: "清理本话题可追踪群消息" },
  { command: "broadcast", description: "向全部用户群发公告（General 使用）" },
  { command: "wipealldata", description: "删除全部话题并清空数据（两步确认）" },
];

/** /ban 确认：回 topic，携带目标用户 ID 便于管理员核对 */
export function formatBanConfirmed(userId: number): string {
  return `已禁言用户 ${userId}：其后续消息将被拦截。`;
}

/** /unban 确认：回 topic */
export function formatUnbanConfirmed(userId: number): string {
  return `已解除用户 ${userId} 的禁言。`;
}

/* ------------------------------------------------------------------ */
/* 备注 / 高危 / 验证开关与模式文案                                        */
/* ------------------------------------------------------------------ */

/** /note 确认：回 topic，回显写入的备注便于管理员核对 */
export function formatNoteConfirmed(note: string): string {
  return `已添加备注：${note}`;
}

/** /unnote 确认：回 topic */
export function formatUnnoteConfirmed(): string {
  return "已清除备注。";
}

/** /note 缺参数的用法提示：绝不误写空备注 */
export const NOTE_USAGE_NOTICE = "用法：/note <内容>（备注将展示在置顶信息中）";

/**
 * /risk 确认：回 topic，携带目标用户 ID + 提醒一次性行为说明
 *（重新标记后下一条消息会再提醒一次）。
 */
export function formatRiskConfirmed(userId: number): string {
  return `已标记用户 ${userId} 为高危用户：其来信将在话题内醒目提醒（24 小时内不重复）。`;
}

/** /unrisk 确认：回 topic */
export function formatUnriskConfirmed(userId: number): string {
  return `已取消用户 ${userId} 的高危标记。`;
}

/**
 * 高危用户来信提醒：发到 topic 内的醒目提示（⚠️ 前后缀 + 展示名），
 * 24 小时窗口内仅一条；displayName 为用户昵称（置顶信息同款回退链产物）。
 * 中继 / 账本照常——提醒只是附着物，不影响主链。
 */
export function formatRiskTopicNotice(displayName: string): string {
  return `⚠️ 高危用户来信提醒 ⚠️\n${displayName} 已被标记为高危用户，请注意甄别、谨慎处理。`;
}

/**
 * /verifyon 确认：含「已验证记录不受影响」说明——重开后已验证
 *（且未过期）用户照常通行，绝不误重验。
 */
export function formatVerifyOnConfirmed(): string {
  return "人机验证已开启。此前已验证的用户不受影响，无需重新验证。";
}

/**
 * /verifyoff 确认：含验证记录保留、重新开启后按记录与有效期判定
 * 的说明——关闭只是「整门跳过」，不动任何验证记录。
 */
export function formatVerifyOffConfirmed(): string {
  return "人机验证已临时关闭：新消息不再要求验证。已验证记录全部保留，重新开启后按记录与有效期判定，已验证且未过期的用户无需重验。";
}

/**
 * /verifymode 确认：携带切换后的新模式；
 * 纯按钮附防护较弱说明（bot 可直接调 API 点击）；Turnstile 附入口说明。
 */
export function formatVerifyModeConfirmed(mode: "math" | "button" | "turnstile"): string {
  if (mode === "math") return "验证模式已切换为数学题。";
  if (mode === "button") {
    return "验证模式已切换为纯按钮。注意：纯按钮模式防护较弱，bot 可直接调 API 点击，仅建议受信任场景使用。";
  }
  return "验证模式已切换为 Turnstile 人机验证：未验证用户将通过私聊按钮打开网页完成校验（需已配置 TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY）。切换已作废全部旧验证题与网页请求，已验证用户不受影响。";
}

/**
 * /verifymode 无参数查看（只读）：当前模式 + 切换命令。绝不写设置、不清 pending、
 * 不循环切换（以三个专用切换命令为准，参数形式降为兼容别名）。
 */
export function formatVerifyModeCurrent(settings: HelpSettings): string {
  return [
    `当前验证模式：${verifyModeLabel(settings.verifyMode)}`,
    "切换命令：/verifymode_math（数学题）、/verifymode_button（纯按钮）、/verifymode_turnstile（Turnstile 人机验证）。",
    "兼容别名：/verifymode math|button|turnstile；无参数仅查看，不改变任何设置。",
  ].join("\n");
}

/** /verifymode 非法参数：拒绝且不改变任何设置 / pending（以新命令为准，别名附注） */
export const VERIFYMODE_USAGE_NOTICE =
  "未知模式。用法：/verifymode_math、/verifymode_button、/verifymode_turnstile 或别名 /verifymode math|button|turnstile（无参数仅查看当前模式，不改变设置）。";

/** 验证配置命令在非 General Topic 执行：不执行、仅引导去 General */
export const VERIFY_COMMANDS_GENERAL_ONLY_NOTICE =
  "验证配置命令请在客服群 General 中使用。";

/** /verifymode turnstile 但配置缺失：拒绝切换、不清 pending（点名缺哪些变量） */
export function formatVerifyModeMissingTurnstileConfig(missing: string[]): string {
  return `无法切换为 Turnstile 模式：缺少必需配置 ${missing.join("、")}。当前设置与待验证用户的题目均未改变；配置完成后请在客服群 General 重新执行 /verifymode_turnstile。`;
}

/**
 * 纯按钮模式题面：单按钮 + 引导文案（与数学题共用「为确认你是
 * 真人」句式，保持验证语义一致）。
 */
export function formatVerifyButtonQuestion(): string {
  return "为确认你是真人，请点击下方按钮确认你不是机器人。";
}

/** 纯按钮模式的唯一按钮文案：点击即提交答案 0 */
export const VERIFY_BUTTON_LABEL = "我不是机器人";

/* ------------------------------------------------------------------ */
/* Turnstile 人机验证模式文案                                              */
/* ------------------------------------------------------------------ */

/**
 * Turnstile 模式题面：web_app 按钮引导文案（含 10 分钟链接有效期提示——
 * 请求自创建起 600 秒，过期回 Bot 重新发起）。
 */
export function formatVerifyTurnstileQuestion(): string {
  return "为确认你是真人，请点击下方按钮打开验证页面完成人机验证。\n验证链接 10 分钟内有效，过期请发送任意消息重新获取。";
}

/** Turnstile 模式超限合并消息前缀（与数学题 / 纯按钮同款限频语义） */
export function formatRateLimitVerifyTurnstile(limit: number): string {
  return `发送过快，每分钟最多 ${limit} 条消息，本条未送达。请重新完成验证：\n\n${formatVerifyTurnstileQuestion()}`;
}

/** Turnstile 模式的唯一按钮文案：打开 Mini App 验证页面 */
export const VERIFY_TURNSTILE_BUTTON_LABEL = "打开验证页面";

/* ------------------------------------------------------------------ */
/* 会话维护：archive / deluser / purgemsg / wipealldata 文案               */
/* ------------------------------------------------------------------ */

/** /archive 软归档的 pre-close 确认：必须在 topic 关闭前送达 */
export const ARCHIVE_PREPARING_TEXT = "正在软归档此用户：验证状态将清除，用户与本话题历史、备注会保留。";

/** /archive 软归档后的用户提示；管理员主动操作，不占用户触发式提示频控 slot */
export const ARCHIVE_USER_NOTICE = "本次会话已结束。如需继续联系客服，请重新发送 /start。";
export const DELUSER_WARNING_TEXT = "⚠️ 物理删除确认\n将删除此用户的 Hodor 档案、绑定、账本，以及客服群话题和其中消息。Telegram 私聊窗口中的双方历史不会删除。此操作不可恢复，请在 60 秒内确认。";
export const DELUSER_CONFIRM_LABEL = "确认物理删除";
export const DELUSER_CANCEL_LABEL = "取消";
export const DELUSER_TOAST_EXPIRED = "确认已超时，请重新发起 /deluser。";
export const DELUSER_TOAST_CANCELLED = "已取消，未删除数据。";
export const DELUSER_TOAST_NOT_ADMIN = "该操作仅客服管理员可用。";
export const DELUSER_TOAST_DONE = "群内话题与 Hodor 数据已删除；私聊历史保留。";
export const DELUSER_TOAST_FAILED = "Telegram 未能删除话题，数据已保留。";
export const ARCHIVE_SUCCESS_TEXT = "用户已软归档：验证与待答题已清除，话题已关闭。用户、绑定、消息历史与备注均保留；用户重新联系后会自动恢复原话题，并在验证开启时重新验证。";
export const ARCHIVE_CLOSE_FAILED_TEXT = "归档未执行：Telegram 未能关闭话题，用户数据与验证状态未变。请检查权限后重试。";

/**
 * /purgemsg 确认：三态计数——不把未删除内容标为已清空（failed>0
 * 时明确「有内容未清空」）。gone = 已不存在（可能已被手工删，重推重跑
 * 的收敛类）；failed = 权限不足等其他 permanent。pinnedReset 标记信息卡
 * 是否成功重置（false → 注明下次消息自动补发，不虚报已重置）。
 */
export function formatPurgeConfirmed(counts: {
  deleted: number;
  gone: number;
  failed: number;
  pinnedReset: boolean;
}): string {
  const lines = [`本话题消息清理完成：已删除 ${counts.deleted} 条`];
  if (counts.gone > 0) lines.push(`${counts.gone} 条已不存在（可能此前已被删除）`);
  if (counts.failed > 0) {
    lines.push(`⚠️ ${counts.failed} 条删除失败（bot 可能缺少「删除消息」权限），这些内容未清空，可手动删除。`);
  }
  lines.push(
    counts.pinnedReset
      ? "用户信息已重新发送并置顶。"
      : "⚠️ 用户信息未能重新置顶，下次收到用户消息时会自动补发。",
  );
  return lines.join("\n");
}

/**
 * /wipealldata 第一步警告：明确不可恢复范围与保留项。60 秒内点击
 * 「确认清空」才执行；完成文案独立（编辑本消息）。
 */
export const WIPE_WARNING_TEXT = [
  "⚠️ 危险操作 ⚠️",
  "将删除客服群内全部话题及其中群内消息，并清空全部数据，不可恢复：",
  "- 全部用户档案与验证 / 封禁 / 备注状态",
  "- 全部用户 ↔ 话题绑定",
  "- 全部消息记录",
  "- 客服群内全部话题（General 除外）",
  "",
  "保留：验证开关与模式（settings）、幂等台账（processed_updates）、Bot 身份（bots）。双方私聊窗口消息不在删除范围。",
  "",
  "请在 60 秒内点击按钮确认或取消。",
].join("\n");

/** /wipealldata 确认按钮文案：callback_data 由 wipe.ts 组装（w:yes:<epoch>） */
export const WIPE_CONFIRM_LABEL = "⚠️ 确认清空（不可恢复）";

/** /wipealldata 取消按钮文案 */
export const WIPE_CANCEL_LABEL = "取消";

/** /wipealldata 确认执行后的完成文案（尝试编辑原警告消息；话题已被删时 edit 失败 warn 吞） */
export const WIPE_DONE_TEXT =
  "已删除客服群内全部话题（General 除外）并清空全部用户、绑定与消息记录。验证开关与模式保留。用户再次私聊将全新建档。";

/** /wipealldata 话题删除部分失败：不清库，提示失败数并引导重试 */
export function formatWipeTopicsFailed(failed: number): string {
  return `${failed} 个话题删除失败，数据未清空。请检查 bot 权限后重新发起 /wipealldata 继续删除。`;
}

/** /wipealldata 完成提示（话题已删，警告消息不在——toast 是主要反馈） */
export const WIPE_TOAST_DONE = "全部话题与 Hodor 数据已删除；私聊历史保留。";

/** wipe 回调 toast：非管理员（再次鉴权失败） */
export const WIPE_TOAST_NOT_ADMIN = "该操作仅客服管理员可用。";

/** wipe 回调 toast：超过 60 秒有效期 */
export const WIPE_TOAST_EXPIRED = "确认已超时（60 秒），本次操作已放弃。请重新发起 /wipealldata。";

/** wipe 回调 toast：取消 */
export const WIPE_TOAST_CANCELLED = "已取消，未清空任何数据。";

/** wipe 回调 toast：确认后开始执行 */
export const WIPE_TOAST_RUNNING = "已确认，正在清空…";

/* ------------------------------------------------------------------ */
/* 全用户广播：输入提示 / 控制消息状态 / 结束统计文案                      */
/* ------------------------------------------------------------------ */

/**
 * getMe 成功但无显示名（first_name 空白）时的落款回退。
 * 获取失败仍不出可确认预览、不用库存旧名。
 */
export const BROADCAST_FALLBACK_SIGNATURE = "Hodor";

/**
 * /broadcast 用法提示：在 General 中回发；标题与正文均必填、
 * 超长拒绝后引导修改。
 */
export const BROADCAST_USAGE_NOTICE =
  "用法：在客服群 General 中发送一条完整消息——\n/broadcast 公告标题\n\n正文（可含空行，按普通文字发送）\n\n标题与正文均必填，二者以第一个换行分隔。";

/** Topic 内发起只提示去 General：不创建广播、绝不中继给该用户 */
export const BROADCAST_TOPIC_REDIRECT =
  "广播请在客服群 General 中发起：到 General 发送 /broadcast + 标题与正文（首行命令，换行后为正文）。";

/** 非管理员发起（General 回发；与既有命令提示同语义） */
export const BROADCAST_NOT_ADMIN_NOTICE = "该命令仅客服管理员可用。";

/** 预计收件人为 0：只提示，不提供可确认广播 */
export const BROADCAST_EMPTY_RECIPIENTS_NOTICE =
  "当前没有符合资格的用户（需有话题绑定且未被禁言），未创建广播。";

/** 预计人数超过 500 上限：拒绝启动，不截断 */
export function formatBroadcastTooManyRecipients(limit: number): string {
  return `符合资格的用户超过 ${limit} 人上限，本次广播未创建。当前版本不支持分组收件人，请联系维护者评估扩容方案。`;
}

/** 最终可见文本超过 4096：超长拒绝并提示修改，不截断、不拆分 */
export function formatBroadcastTooLong(limit: number): string {
  return `公告全文（含标题、落款与空行）超过 ${limit} 字符上限，请精简后重新发起。`;
}

/** getMe 失败：不生成可确认预览，不用库存旧名称 */
export const BROADCAST_GETME_FAILED_NOTICE =
  "暂时无法获取 Bot 名称，本次广播未发起。请稍后重新发送 /broadcast。";

/** 预览已发出但落库失败（补偿）：尽力回发提示后抛出交重推 */
export const BROADCAST_PREVIEW_CREATE_FAILED_NOTICE =
  "预览创建失败，本次广播未发送，请忽略上方消息。";

/** 控制消息发送 permanent（补偿）：按钮无效，任务终止 */
export const BROADCAST_CONTROL_CREATE_FAILED_NOTICE =
  "控制消息创建失败，按钮无效：本次广播未发送，请重新发起 /broadcast。";

/** 同 Bot 已有草稿/待确认：同一时间只留一份草稿 */
export const BROADCAST_DRAFT_EXISTS_NOTICE =
  "已有广播待确认或发送中草稿未过期，请先完成处理或等待其过期后再发起新广播。";

/** 控制消息初始文案（待确认）：预计人数 + 有效期 */
export function formatBroadcastControlText(expectedCount: number, ttlMinutes: number): string {
  return [
    "📋 广播确认（未发送）",
    `预计收件用户：${expectedCount} 名`,
    `请在 ${ttlMinutes} 分钟内确认；超时未确认自动作废。仅发起人可操作。`,
  ].join("\n");
}

/** 控制消息按钮文案（callback_data 由 pipeline 组装为 b:y|n:<id>） */
export const BROADCAST_CONFIRM_LABEL = "确认发送";
export const BROADCAST_CANCEL_LABEL = "取消";

/** 发送中：移除按钮；编辑为 best-effort，失败不阻断主循环 */
export const BROADCAST_SENDING_TEXT = "📤 正在发送…";

/** 已取消（未发送） */
export const BROADCAST_CANCELLED_TEXT = "已取消（未发送）。";

/** 已过期（未发送） */
export const BROADCAST_EXPIRED_TEXT = "已过期（未发送）。";

/** 确认时资格人数变为 0：原子改 cancelled，不因人数变化复活 */
export const BROADCAST_NO_RECIPIENTS_TEXT = "当前无可发送用户，本次广播已取消（未发送）。";

/**
 * 完成统计：成功仅表示 Telegram API 接收 + 系统记录成功，不代表
 * 已读；失败含 API 失败与发送前资格变化，不自动补发。
 */
export function formatBroadcastDoneText(successCount: number, failureCount: number): string {
  return [
    `✅ 广播完成：成功 ${successCount}，失败 ${failureCount}。`,
    "成功仅表示 Telegram 已接收，不代表用户已阅读；失败不自动补发。",
  ].join("\n");
}

/** 中断（诚实边界）：滞留行陈旧判定后统一文案，不承诺补发 */
export const BROADCAST_INTERRUPTED_TEXT = "⚠️ 广播中断，结果未知；未自动补发。";

/* ----- 回调 toast（answerCallbackQuery；均 best-effort，失败不阻断） ----- */

/** 非管理员点击（再次鉴权） */
export const BROADCAST_TOAST_NOT_ADMIN = "该操作仅客服管理员可用。";

/** 点击者不是发起人（R9：只有发起管理员本人可以确认或取消） */
export const BROADCAST_TOAST_NOT_INITIATOR = "只有发起本次广播的管理员可以确认或取消。";

/** 已有广播正在发送（R10：不自动排多个广播，pending 保留至自然过期） */
export const BROADCAST_TOAST_BUSY = "已有广播正在发送，请稍后再试。";

/** 重复点击 / 已被并发方裁决 / 行已删除（孤立按钮） */
export const BROADCAST_TOAST_ALREADY_HANDLED = "该广播已处理或不存在。";

/** 重推重跑看到 sending 未陈旧：绝不并发第二份发送 */
export const BROADCAST_TOAST_SENDING = "正在发送中，请稍候。";

/** 取消成功 */
export const BROADCAST_TOAST_CANCELLED = "已取消，未发送。";

/** 过期 */
export const BROADCAST_TOAST_EXPIRED = "预览已过期，请重新发起 /broadcast。";

/** 确认成功、开始发送 */
export const BROADCAST_TOAST_CONFIRMED = "已确认，开始发送。";

/** 完成修复路径（重投重跑见 completed） */
export const BROADCAST_TOAST_DONE = "广播已完成。";
