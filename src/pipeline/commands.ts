/**
 * 命令管线（T34 /help + T35 /ban /unban + T36/T37 note / risk 组 + T31/T32
 * verifyon / verifyoff / verifymode 组，design.md §二.6 / §二.9 / §二.10 +
 * §四失败表）：
 *
 * outbound 在管理员校验后把 `/` 开头的文本消息整条移交本管线——**一律按
 * 命令终结，永不中继、永不写账本**（命令是客服侧治理操作而非对话内容）；
 * 非管理员 `/` 沿用阶段 3 静默（outbound 管理员校验已挡，本文件不重复判）。
 *
 * 命令语义：
 * - /help → 回当前 topic formatHelpText（只列已交付命令 + 「/ 开头消息不中继」；
 *   验证段接库内 settings 真值——开 → 展示 /verifyoff，关 → /verifyon）
 * - /ban / /unban → 反查绑定（**open 与 closed 均可操作**——治理操作不依赖
 *   topic 开放；无绑定 → 复用 T26 UNBOUND_TOPIC_NOTICE）→ setBanned
 *   （DB 真值先行，幂等 setter——确认消息失败重推不产生二次状态翻转）
 *   → topic 内确认（携带目标用户 ID 便于管理员核对）
 * - /note / /unnote / /risk / /unrisk（T36/T37，/ban 同姿态需绑定组）：
 *   /note 空参数先回用法提示（绝不误写空备注）；有绑定 → 幂等 setter 落库
 *   （DB 真值先行）→ 置顶刷新（editPinnedBestEffort，best-effort）→ topic
 *   确认（回显写入的备注 / 携带目标用户 ID）。/risk 的窗口重置语义在 setter
 *   内（置 1 清 risk_notice_at——下一条消息重新提醒一次）
 * - /verifyon / /verifyoff / /verifymode（T31/T32，**全局命令**——/help 同
 *   姿态，任意 topic 可执行无需绑定）：开关 = 幂等 setter（重复执行同值
 *   无害，确认照发）；/verifymode 无参循环切换（math ↔ button），先
 *   clearAllPendingVerifications 后 setVerificationMode（顺序 binding，见
 *   分支注释），确认携带新模式 + button 弱防护说明
 * - 未知命令 → topic 内「未知命令」提示并引导 /help，**绝不发给用户**
 *
 * 失败语义（design.md §四「命令回复」行，binding）：回复 retryable → 抛
 * （webhook 500 → 重推重发回复）；permanent → warn 吞（跳过该条回复）。
 * 置顶刷新恒 best-effort（§三「命令内置顶刷新」行：确认回复已反馈，edit
 * 两种失败均 warn 吞）。命令回复全部发回管理员发言的同一 topic（classify
 * 保证 chat 即客服群）：零用户侧消息、零 messages 账本行（系统消息不入
 * 账本，error-handling spec）。
 */
import {
  formatBanConfirmed,
  formatHelpText,
  formatNoteConfirmed,
  formatRiskConfirmed,
  formatUnbanConfirmed,
  formatUnnoteConfirmed,
  formatUnriskConfirmed,
  formatVerifyModeConfirmed,
  formatVerifyOffConfirmed,
  formatVerifyOnConfirmed,
  NOTE_USAGE_NOTICE,
  UNBOUND_TOPIC_NOTICE,
  UNKNOWN_COMMAND_NOTICE,
} from "../copy";
import { editPinnedBestEffort } from "./pinned";
import { findUserIdByThread, setTopicNote } from "../store/topics";
import {
  clearAllPendingVerifications,
  setBanned,
  setRisk,
} from "../store/users";
import {
  getVerificationSettings,
  setVerificationEnabled,
  setVerificationMode,
} from "../store/settings";
import { createTelegramClient } from "../telegram/client";

/**
 * 备注最大长度（Unicode 码点数）：落库前截断——置顶信息 = 昵称 / ID /
 * 时间等固定行 + 备注行，Telegram 消息上限 4096 字符；500 码点（emoji
 * 等增补平面字符按 1 计）给备注行留出充裕空间的同时保证 editMessageText
 * 绝不超限。按码点（而非 UTF-16 code unit）截断，避免把 emoji 从中间
 * 切成乱码。
 */
const NOTE_MAX_CODEPOINTS = 500;

/**
 * 解析命令名：首 token 去 `@botname` 后缀（`/ban@hodor_bot 附加参数` →
 * `/ban`）。命令只看首 token；是否为命令（`/` 前缀）由调用方 outbound
 * 先行判定。
 */
export function parseCommandName(text: string): string {
  const firstToken = text.split(/\s+/)[0] ?? "";
  const at = firstToken.indexOf("@");
  return at === -1 ? firstToken : firstToken.slice(0, at);
}

/**
 * 解析命令参数（/note 消费）：首 token（命令名，可带 @bot 后缀）之后的
 * 剩余文本，trim 两端。内部空白原样保留（备注内容不该被压缩重排）；
 * `/note` / `/note   ` → ""（空参数，调用方回用法提示）。
 */
export function parseCommandArgs(text: string): string {
  return text.replace(/^\S+\s*/, "").trim();
}

/** topic 内命令回复的三态消费：retryable → 抛（重推）；permanent → warn 吞 */
async function replyInTopic(
  env: Cloudflare.Env,
  chatId: number,
  threadId: number,
  text: string,
): Promise<void> {
  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const sent = await client.sendMessage({ chat_id: chatId, text, message_thread_id: threadId });
  if (!sent.ok) {
    if (sent.kind === "retryable") {
      throw new Error(sent.errorMessage ?? "sendMessage retryable");
    }
    console.warn(
      `[commands] thread ${threadId}: 命令回复 permanent，跳过：${sent.errorMessage ?? "no detail"}`,
    );
  }
}

/**
 * 处理一条管理员命令（outbound 管理员校验 + thread 校验后移交）。
 * 完成（resolve）= 按成功处理；抛出（reject）= retryable，交 webhook 500 重推。
 * 无论命中哪条分支，本函数返回后该 update 即告终结——outbound 不再走
 * 绑定查找 / 中继 / 账本（「/ 开头永不中继」的唯一保证点）。
 */
export async function handleCommand(
  env: Cloudflare.Env,
  botId: number,
  params: { chatId: number; threadId: number; text: string },
): Promise<void> {
  const { chatId, threadId } = params;
  const name = parseCommandName(params.text);

  if (name === "/help") {
    // /help 不依赖绑定：无论哪个 topic 都能看（含无绑定 / closed topic）。
    // 帮助接库内 settings 真值（T32 动态化）：验证段随开关 / 模式变化——
    // 开 → 只展示 /verifyoff，关 → /verifyon + 「当前验证已关闭」标注
    await replyInTopic(
      env,
      chatId,
      threadId,
      formatHelpText(await getVerificationSettings(env.HODOR_DB)),
    );
    return;
  }

  if (name === "/ban" || name === "/unban") {
    // 反查绑定：closed 行同样可操作（管理操作不依赖 open——区别于中继的
    // 「closed 视同未绑定」）；无行 → 复用 T26 提示（绝不猜测目标用户）
    const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
    if (!owner) {
      await replyInTopic(env, chatId, threadId, UNBOUND_TOPIC_NOTICE);
      return;
    }
    // DB 真值先行（幂等 setter）：确认回复 retryable → 抛 → 重推只会
    // 重发回复并重复执行同一赋值，不产生状态振荡或用户侧副作用
    await setBanned(env.HODOR_DB, botId, owner.user_id, name === "/ban");
    await replyInTopic(
      env,
      chatId,
      threadId,
      name === "/ban"
        ? formatBanConfirmed(owner.user_id)
        : formatUnbanConfirmed(owner.user_id),
    );
    return;
  }

  /* ------------- T36/T37 备注与高危组（需绑定，/ban 同姿态） ------------- */
  if (name === "/note" || name === "/unnote" || name === "/risk" || name === "/unrisk") {
    // /note 空参数：用法提示先于绑定判定（M2 契约——本命令的核心防御是
    // 「绝不误写空备注」，误触 /note 不该落到任何绑定语义）
    const args = parseCommandArgs(params.text);
    if (name === "/note" && args === "") {
      await replyInTopic(env, chatId, threadId, NOTE_USAGE_NOTICE);
      return;
    }
    // 反查绑定：closed 行同样可操作（治理操作不依赖 open）；无行 → T26 提示
    const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
    if (!owner) {
      await replyInTopic(env, chatId, threadId, UNBOUND_TOPIC_NOTICE);
      return;
    }
    const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
    if (name === "/note") {
      // 长度防御：按码点截断（NOTE_MAX_CODEPOINTS 详见常量注释）——确认
      // 回显截断后的值（= 实际落库值，copy 契约「回显写入的备注」）
      const note = [...args].slice(0, NOTE_MAX_CODEPOINTS).join("");
      // DB 真值先行（幂等 setter）：确认 / 置顶刷新失败重推只会重发回复
      // 并重复执行同一赋值，不产生状态振荡或用户侧副作用
      await setTopicNote(env.HODOR_DB, botId, owner.user_id, note);
      await editPinnedBestEffort(env, client, botId, owner.user_id);
      await replyInTopic(env, chatId, threadId, formatNoteConfirmed(note));
      return;
    }
    if (name === "/unnote") {
      await setTopicNote(env.HODOR_DB, botId, owner.user_id, null);
      await editPinnedBestEffort(env, client, botId, owner.user_id);
      await replyInTopic(env, chatId, threadId, formatUnnoteConfirmed());
      return;
    }
    // /risk / /unrisk：setRisk 单语句同时清 risk_notice_at（重新标记 →
    // 24h 提醒窗口重置；取消 → 行内不留悬空窗口）
    const risk = name === "/risk";
    await setRisk(env.HODOR_DB, botId, owner.user_id, risk);
    await editPinnedBestEffort(env, client, botId, owner.user_id);
    await replyInTopic(
      env,
      chatId,
      threadId,
      risk ? formatRiskConfirmed(owner.user_id) : formatUnriskConfirmed(owner.user_id),
    );
    return;
  }

  /* ------------- T31/T32 验证配置组（全局命令，/help 同姿态无需绑定） ------------- */
  if (name === "/verifyon" || name === "/verifyoff") {
    // 幂等 setter（DB 真值先行）：重复执行同值无害——确认回复失败重推只会
    // 重发回复并重复执行同一赋值；关闭 = 整门跳过但**不动任何验证记录**
    //（is_verified / verified_at 原样保留，重开后按记录与 TTL 判定）
    const enable = name === "/verifyon";
    await setVerificationEnabled(env.HODOR_DB, enable);
    await replyInTopic(
      env,
      chatId,
      threadId,
      enable ? formatVerifyOnConfirmed() : formatVerifyOffConfirmed(),
    );
    return;
  }

  if (name === "/verifymode") {
    // 无参循环切换（math ↔ button）。两步 setter **顺序 binding**：先
    // clearAllPendingVerifications 后 setVerificationMode——清题失败抛出时
    // settings 未变、旧题继续有效，无半切换态（旧题回调绝不误通过：归属
    // 判定 verify_msg_id 单道检查不变，被清空即落「题目已失效」分支）。
    // 两步非原子（D1 无跨语句事务）的已接受权衡：清题成功而 set 失败 →
    // settings 仍旧模式但旧题已清，用户下一条消息按旧模式出新题，安全
    // 无害；重推 / 再次执行 /verifymode 均收敛到一致态
    const { verifyMode } = await getVerificationSettings(env.HODOR_DB);
    const nextMode = verifyMode === "math" ? "button" : "math";
    await clearAllPendingVerifications(env.HODOR_DB);
    await setVerificationMode(env.HODOR_DB, nextMode);
    await replyInTopic(env, chatId, threadId, formatVerifyModeConfirmed(nextMode));
    return;
  }

  // 未知命令（含 /、/foo、群内误用的 /start 等）：提示管理员并引导 /help
  await replyInTopic(env, chatId, threadId, UNKNOWN_COMMAND_NOTICE);
}
