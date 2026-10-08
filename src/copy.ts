/**
 * 用户 / 管理员可见文案的唯一集中点（T23 / T24 / T26 + 阶段 4 T27/T29/T34/T35
 * + 阶段 5 T31/T32/T36/T37）。
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

/** 置顶验证行的三态（T31 开关交付起布尔真值升为三态） */
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
   * 验证行三态（T31）：verified / unverified 按库内真值（users.is_verified），
   * disabled = 验证开关关闭期间（恒「未启用」，覆盖真值——此时无从谈验证状态）
   */
  verify: PinnedVerifyState;
  /** 高危标记（users.is_risk，T37）：true → 追加「高危：⚠️ 高危用户」行 */
  isRisk?: boolean;
  /** 管理员备注（topics.note，T36）：非空 → 追加「备注：<text>」行 */
  note?: string | null;
}

/** 三态验证行文案（disabled 无 emoji——验证未启用时绝不伪称任何状态） */
const VERIFY_STATUS_TEXT: Record<PinnedVerifyState, string> = {
  verified: "✅ 已验证",
  unverified: "❌ 未验证",
  disabled: "未启用",
};

/**
 * 置顶的用户信息（T24 + 阶段 4 验证行 + 阶段 5 高危 / 备注行）：
 * 昵称（含 @username 括注）/ 用户 ID / 首次聊天（截到分钟）/ 验证状态
 * （三态）/ 高危（仅 isRisk）/ 备注（仅非空）。
 *
 * - 昵称回退链：first+last_name → @username → ID_<id>；括注只在展示名来自
 *   姓名且存在 @username 时携带（否则会与回退名重复）
 * - 验证行三态（T31 开关交付起）：✅ 已验证 / ❌ 未验证 / 未启用
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
 * 答错重出的错误提示前缀（T27 + T32 模式化）：与 buildChallenge 产出的
 * 模式化题面拼接成重出正文（编辑到**同一题面消息**——无新推送，天然不占
 * 提示频控）。math 模式下拼接产物与下方 formatVerifyRetryQuestion 逐字一致。
 */
export const VERIFY_RETRY_PREFIX = "回答错误，请再试一次。\n\n";

/**
 * 答错重出正文（T27，math 模式定稿形态）：错误提示 + 新题（题头 + 算式）。
 */
export function formatVerifyRetryQuestion(expression: string): string {
  return `${VERIFY_RETRY_PREFIX}${formatVerifyQuestion(expression)}`;
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

/**
 * 超限合并消息正文——纯按钮模式变体（T29 + T32）：限频提示前缀与数学题
 * 形态逐字一致（超限语义不随模式变化），题面换为纯按钮引导文案 + 单按钮
 * （按钮本体由 buildChallenge 组装，本函数只管文字）。
 */
export function formatRateLimitVerifyButton(limit: number): string {
  return `发送过快，每分钟最多 ${limit} 条消息，本条未送达。请重新完成验证：\n\n${formatVerifyButtonQuestion()}`;
}

/** 禁言提示（T35）：封禁门拦截用户消息时经提示频控发给用户 */
export const BAN_NOTICE = "你已被禁言，消息无法送达客服。如有疑问请通过其他方式联系。";

/**
 * /help 文案（T34 + T32 动态化）：只列**已交付**命令；验证段随当前开关与
 * 模式变化——只展示「可操作的那个」开关命令（开 → /verifyoff，关 →
 * /verifyon），未交付命令绝不提前展示。后续阶段新增命令时在此增行。
 */
export interface HelpSettings {
  verifyEnabled: boolean;
  verifyMode: "math" | "button";
}

/** 验证模式的帮助侧中文名（/verifymode 行与切换确认共用） */
export function verifyModeLabel(mode: "math" | "button"): string {
  return mode === "math" ? "数学题" : "纯按钮";
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
    "/deluser - 删除本话题用户（关闭话题、清除验证，历史与备注保留，用户重新 /start 后复用本话题重开）",
    "/purgemsg - 清空本话题全部聊天消息并重置置顶",
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
    `/verifymode - 切换验证模式（当前：${verifyModeLabel(settings.verifyMode)}）`,
    "纯按钮模式防护较弱，bot 可直接调 API 点击，仅建议受信任场景使用。",
    "",
    "危险操作：",
    "/wipealldata - 清空全部用户、话题绑定与消息记录（两步确认，不可恢复）",
    "",
    "说明：以 / 开头的消息不会中继给用户。",
  );
  return lines.join("\n");
}

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
 * 小写无斜杠（Telegram BotCommand 规范）。菜单**恒全量注册**（不随开关
 * 动态变化——Telegram 菜单是客户端缓存，动态化弊大于利；帮助文本才是
 * 动态面），并与 formatHelpText 的「已交付命令」清单保持同步。已部署
 * 实例需重跑 setwebhook 刷新菜单。
 */
export const ADMIN_COMMAND_MENU: readonly { command: string; description: string }[] = [
  { command: "help", description: "查看管理命令帮助" },
  { command: "ban", description: "封禁本话题用户" },
  { command: "unban", description: "解封本话题用户" },
  { command: "note", description: "添加用户备注" },
  { command: "unnote", description: "清除用户备注" },
  { command: "risk", description: "标记高危用户" },
  { command: "unrisk", description: "取消高危标记" },
  { command: "verifyon", description: "开启人机验证" },
  { command: "verifyoff", description: "临时关闭人机验证" },
  { command: "verifymode", description: "切换验证模式" },
  { command: "deluser", description: "删除本话题用户并关闭话题" },
  { command: "purgemsg", description: "清空本话题消息并重置置顶" },
  { command: "wipealldata", description: "清空全部数据（两步确认）" },
];

/** /ban 确认（T35）：回 topic，携带目标用户 ID 便于管理员核对 */
export function formatBanConfirmed(userId: number): string {
  return `已禁言用户 ${userId}：其后续消息将被拦截。`;
}

/** /unban 确认（T35）：回 topic */
export function formatUnbanConfirmed(userId: number): string {
  return `已解除用户 ${userId} 的禁言。`;
}

/* ------------------------------------------------------------------ */
/* 阶段 5：备注（T36）/ 高危（T37）/ 验证开关与模式（T31/T32）文案        */
/* ------------------------------------------------------------------ */

/** /note 确认（T36）：回 topic，回显写入的备注便于管理员核对 */
export function formatNoteConfirmed(note: string): string {
  return `已添加备注：${note}`;
}

/** /unnote 确认（T36）：回 topic */
export function formatUnnoteConfirmed(): string {
  return "已清除备注。";
}

/** /note 缺参数的用法提示（T36）：绝不误写空备注 */
export const NOTE_USAGE_NOTICE = "用法：/note <内容>（备注将展示在置顶信息中）";

/**
 * /risk 确认（T37）：回 topic，携带目标用户 ID + 提醒一次性行为说明
 *（重新标记后下一条消息会再提醒一次）。
 */
export function formatRiskConfirmed(userId: number): string {
  return `已标记用户 ${userId} 为高危用户：其来信将在话题内醒目提醒（24 小时内不重复）。`;
}

/** /unrisk 确认（T37）：回 topic */
export function formatUnriskConfirmed(userId: number): string {
  return `已取消用户 ${userId} 的高危标记。`;
}

/**
 * 高危用户来信提醒（T37）：发到 topic 内的醒目提示（⚠️ 前后缀 + 展示名），
 * 24 小时窗口内仅一条；displayName 为用户昵称（置顶信息同款回退链产物）。
 * 中继 / 账本照常——提醒只是附着物，不影响主链。
 */
export function formatRiskTopicNotice(displayName: string): string {
  return `⚠️ 高危用户来信提醒 ⚠️\n${displayName} 已被标记为高危用户，请注意甄别、谨慎处理。`;
}

/**
 * /verifyon 确认（T31）：含「已验证记录不受影响」说明——重开后已验证
 *（且未过期）用户照常通行，绝不误重验。
 */
export function formatVerifyOnConfirmed(): string {
  return "人机验证已开启。此前已验证的用户不受影响，无需重新验证。";
}

/**
 * /verifyoff 确认（T31）：含验证记录保留、重新开启后按记录与有效期判定
 * 的说明——关闭只是「整门跳过」，不动任何验证记录。
 */
export function formatVerifyOffConfirmed(): string {
  return "人机验证已临时关闭：新消息不再要求验证。已验证记录全部保留，重新开启后按记录与有效期判定，已验证且未过期的用户无需重验。";
}

/**
 * /verifymode 确认（T32）：携带切换后的新模式；纯按钮附防护较弱说明
 *（bot 可直接调 API 点击）。
 */
export function formatVerifyModeConfirmed(mode: "math" | "button"): string {
  return mode === "math"
    ? "验证模式已切换为数学题。"
    : "验证模式已切换为纯按钮。注意：纯按钮模式防护较弱，bot 可直接调 API 点击，仅建议受信任场景使用。";
}

/**
 * 纯按钮模式题面（T32）：单按钮 + 引导文案（与数学题共用「为确认你是
 * 真人」句式，保持验证语义一致）。
 */
export function formatVerifyButtonQuestion(): string {
  return "为确认你是真人，请点击下方按钮确认你不是机器人。";
}

/** 纯按钮模式的唯一按钮文案（T32）：点击即提交答案 0 */
export const VERIFY_BUTTON_LABEL = "我不是机器人";

/* ------------------------------------------------------------------ */
/* 阶段 6：会话维护（T38 deluser / T39 purgemsg / T40 wipealldata）文案   */
/* ------------------------------------------------------------------ */

/**
 * /deluser 的用户私聊提示（T38）：告知会话结束与重新入口。直发不占提示
 * 频控 slot——管理员主动触发的治理通知，无用户侧刷量面（T30 防的是用户
 * 触发式轰炸）。permanent（如用户拉黑 bot）→ warn 吞 + 确认注记。
 */
export const DELUSER_USER_NOTICE = "本次会话已结束。如需继续联系客服，请重新发送 /start。";

/**
 * /deluser 确认（T38）：回 topic，携带目标用户 ID + 保留 / 重开语义。
 * 可选注记行：topic 关闭失败（如已被原生删除）、私聊提示未送达——
 * 两个 best-effort 步骤的失败必须让管理员可见（不静默吞治理反馈）。
 */
export function formatDeluserConfirmed(
  userId: number,
  annotations: { closeFailed?: string; noticeFailed?: boolean } = {},
): string {
  const lines = [
    `已删除用户 ${userId}：验证状态已清除，本话题已关闭（历史与备注保留）。`,
    "用户重新 /start 后将复用本话题重开，验证开关开启时会重新验证。",
  ];
  if (annotations.closeFailed) {
    lines.push(`⚠️ 话题关闭未成功：${annotations.closeFailed}`);
  }
  if (annotations.noticeFailed) {
    lines.push("⚠️ 私聊提示未送达（用户可能已拉黑 bot）。");
  }
  return lines.join("\n");
}

/**
 * /purgemsg 确认（T39）：三态计数——不把未删除内容标为已清空（failed>0
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
 * /wipealldata 第一步警告（T40）：明确不可恢复范围与保留项。60 秒内点击
 * 「确认清空」才执行；完成文案独立（编辑本消息）。
 */
export const WIPE_WARNING_TEXT = [
  "⚠️ 危险操作 ⚠️",
  "将清空全部数据，不可恢复：",
  "- 全部用户档案与验证 / 封禁 / 备注状态",
  "- 全部用户 ↔ 话题绑定",
  "- 全部消息记录",
  "",
  "保留：验证开关与模式（settings）、幂等台账；群内已创建的话题不会被自动删除（旧话题内再发言会提示「找不到对应用户」，可手动删除）。",
  "",
  "请在 60 秒内点击按钮确认或取消。",
].join("\n");

/** /wipealldata 确认按钮文案（T40）：callback_data 由 wipe.ts 组装（w:yes:<epoch>） */
export const WIPE_CONFIRM_LABEL = "⚠️ 确认清空（不可恢复）";

/** /wipealldata 取消按钮文案（T40） */
export const WIPE_CANCEL_LABEL = "取消";

/** /wipealldata 确认执行后的完成文案（编辑原警告消息，键盘随之移除） */
export const WIPE_DONE_TEXT =
  "已清空全部用户、话题绑定与消息记录。验证开关与模式保留；群内话题未删除。用户再次私聊将全新建档。";

/** wipe 回调 toast：非管理员（T40 再次鉴权失败） */
export const WIPE_TOAST_NOT_ADMIN = "该操作仅客服管理员可用。";

/** wipe 回调 toast：超过 60 秒有效期 */
export const WIPE_TOAST_EXPIRED = "确认已超时（60 秒），本次操作已放弃。请重新发起 /wipealldata。";

/** wipe 回调 toast：取消 */
export const WIPE_TOAST_CANCELLED = "已取消，未清空任何数据。";

/** wipe 回调 toast：确认后开始执行 */
export const WIPE_TOAST_RUNNING = "已确认，正在清空…";
