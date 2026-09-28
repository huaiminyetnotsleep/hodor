/**
 * pipeline.commands · /purge 与 /deluser（S8，docs/04 两流程逐条落地——高危不可逆，两步确认）。
 *
 * 两步确认（docs/04「确认是无状态的」——不新增任何确认存储）：
 *   /purge（未带 confirm）→ audit purge（发起事件）→ 本 Topic 确认提示（#序号、10 分钟、用法）
 *     → 删命令消息；不删任何数据（发起零删除）。
 *   /purge confirm <#序号> → 校验：序号 === 当前 Topic 绑定 customers.id + 10 分钟窗口
 *     （复用发起审计 findLatestAction 判定，docs/04：不为确认引入存储）→ 通过才执行。
 *   /deluser 同型（deluser action）。
 *
 * 执行顺序（docs/04 不可变，步骤号以代码注释标注）：
 *   /purge   ②audit purge(confirmed) ③删 messages ④删 conversations ⑤deleteForumTopic
 *            ⑥General 公告；customer 行保留（同 #序号新会话，docs/10 场景 19）。
 *   /deluser ②audit deluser(confirmed) ③写墓碑（关门先于删除——防「自动重建新用户」竞态）
 *            ④删 messages ⑤删 conversations ⑥删 customers 行 ⑦deleteForumTopic ⑧General 公告。
 *   纪律：执行 audit 必须先于第一个删除操作（审计先行）；deleteForumTopic 是最后的删除步骤。
 *
 * 为什么整题删除而不是逐条删消息（docs/04「设计取舍」）：Bot API 的 deleteMessage 只能删
 * 48 小时内的消息，覆盖不了历史；deleteForumTopic 无此限制——D1 侧只清引用行。
 *
 * 幂等与崩溃窗口（docs/04/design.md）：执行成功后会话/客户行已删，重复 confirm 在同一
 * （已删）Topic 反查失败 → 静默；deleteForumTopic permanent（Topic 已删等 404 类）→ 视为已删
 * 继续，retryable → 抛出重投——重投重新走 confirm 校验，发起审计仍在窗口内则直接执行，
 * 已删数据再删为 no-op。
 */
import {
  CONFIRM_EXPIRED_NOTICE,
  CONFIRM_MISMATCH_NOTICE,
  renderDeluserConfirmPrompt,
  renderDeluserDoneAnnouncement,
  renderPurgeConfirmPrompt,
  renderPurgeDoneAnnouncement,
} from '../../domain/copy';
import {
  AUDIT_ACTIONS,
  createTombstone,
  deleteByConversation,
  deleteByCustomer,
  deleteById,
  findCommandTargetByThread,
  findLatestAction,
} from '../../store';
import type { UpdateContext } from '../../domain';
import { parseCommand, type CommandHandler } from './registry';
import {
  bestEffort,
  deleteCommandMessage,
  writeCommandAudit,
  type AdminCommandAction,
  type TitleCustomer,
} from './shared';

/** 两步确认窗口（docs/04：10 分钟内、同一 Topic 发送 confirm） */
const CONFIRM_WINDOW_MS = 10 * 60 * 1000;

/** General Topic 的 message_thread_id 恒为 1（Telegram 平台约定；公告目标，docs/04 步骤 ⑤/⑦） */
const GENERAL_THREAD_ID = 1;

/**
 * confirm 子命令解析：args 首词为 confirm（大小写不敏感）→ 进入执行校验（携带序号 token）；
 * 其余（无参或其他文本，docs/04 步骤 2「未带 confirm」）→ 走发起段。
 */
function parseConfirmInvocation(args: string): { confirm: true; idToken: string | undefined } | { confirm: false } {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/);
  const head = tokens[0];
  if (head === undefined || head.toLowerCase() !== 'confirm') {
    return { confirm: false };
  }
  return { confirm: true, idToken: tokens[1] };
}

/**
 * confirm 序号解析（docs/04 步骤 3）：形如 "123" 或 "#123" → 正整数（parseInt）；
 * 缺失/非数字/非正 → undefined（写错号一律拒绝，不猜意图）。
 */
export function parseConfirmNumber(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const digits = token.startsWith('#') ? token.slice(1) : token;
  if (!/^\d+$/.test(digits)) return undefined;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 发起段（docs/04 /purge 步骤 2、/deluser 两步确认同型）：① audit 发起事件先落库——
 * 它是 10 分钟窗口判定的唯一事实源（审计先行原则的发起半场）→ 本 Topic 确认提示 →
 * 删命令消息。不删任何数据（发起零删除）。
 */
async function initiateConfirm(
  ctx: UpdateContext,
  action: AdminCommandAction,
  actorId: number,
  threadId: number,
  customer: TitleCustomer,
  renderPrompt: (customerId: number) => string,
): Promise<void> {
  const { db, bot, telegram } = ctx;
  await writeCommandAudit(db, bot.id, actorId, action, customer);
  await bestEffort('confirm prompt', async () => {
    const sent = await telegram.sendMessage({
      chatId: bot.support_chat_id,
      messageThreadId: threadId,
      text: renderPrompt(customer.id),
    });
    if (!sent.ok) throw new Error(sent.errorMessage ?? 'sendMessage failed');
  });
  await deleteCommandMessage(ctx);
}

/**
 * confirm 校验（docs/04 步骤 3，两命令共用）：序号必须与当前 Topic 绑定客户一致，
 * 且发起审计在 10 分钟窗口内（窗口判定复用发起审计，无状态设计）。
 * 失败发送对应拒绝提示（best-effort）并返回 false——不写执行审计、不删任何数据。
 */
async function validateConfirmation(
  ctx: UpdateContext,
  action: AdminCommandAction,
  threadId: number,
  customer: TitleCustomer,
  idToken: string | undefined,
): Promise<boolean> {
  const { db, bot, telegram } = ctx;
  const confirmId = parseConfirmNumber(idToken);
  if (confirmId === undefined || confirmId !== customer.id) {
    await bestEffort('confirm mismatch notice', async () => {
      const sent = await telegram.sendMessage({
        chatId: bot.support_chat_id,
        messageThreadId: threadId,
        text: CONFIRM_MISMATCH_NOTICE,
      });
      if (!sent.ok) throw new Error(sent.errorMessage ?? 'sendMessage failed');
    });
    return false;
  }
  const intent = await findLatestAction(db, bot.id, action, customer.id);
  if (intent === undefined || Date.now() - Date.parse(intent.createdAt) > CONFIRM_WINDOW_MS) {
    await bestEffort('confirm expired notice', async () => {
      const sent = await telegram.sendMessage({
        chatId: bot.support_chat_id,
        messageThreadId: threadId,
        text: CONFIRM_EXPIRED_NOTICE,
      });
      if (!sent.ok) throw new Error(sent.errorMessage ?? 'sendMessage failed');
    });
    return false;
  }
  return true;
}

/**
 * 整题删除（/purge 步骤 ⑤、/deluser 步骤 ⑦——两者最后的数据删除步骤）：
 * retryable → 抛出 → inbox 5xx → Telegram 重投（重投重新走 confirm 校验，幂等）；
 * permanent（Topic 已手动删除等 404 类）→ 视为已删继续（docs/04 崩溃窗口预案），差异留日志供对账。
 */
async function deleteTopicStrict(ctx: UpdateContext, threadId: number): Promise<void> {
  const deleted = await ctx.telegram.deleteForumTopic({
    chatId: ctx.bot.support_chat_id,
    messageThreadId: threadId,
  });
  if (!deleted.ok) {
    if (deleted.kind === 'retryable') {
      throw new Error(`deleteForumTopic failed (retryable): ${deleted.errorMessage ?? 'unknown error'}`);
    }
    console.error(
      `[commands] deleteForumTopic failed (permanent, treated as deleted): ${deleted.errorMessage ?? 'unknown error'}`,
    );
  }
}

/**
 * General Topic 公告（/purge 步骤 ⑥、/deluser 步骤 ⑧：Topic 本体已删，公告与审计是
 * 仅存的痕迹，文案含 #序号；classify 对 General 是 ignore——发送用 client 直发；best-effort）。
 */
async function announceGeneral(ctx: UpdateContext, text: string): Promise<void> {
  await bestEffort('general announcement', async () => {
    const sent = await ctx.telegram.sendMessage({
      chatId: ctx.bot.support_chat_id,
      messageThreadId: GENERAL_THREAD_ID,
      text,
    });
    if (!sent.ok) throw new Error(sent.errorMessage ?? 'sendMessage failed');
  });
}

/**
 * /purge（docs/04「/purge 流程」逐条；前置白名单/支持群/解析已由 handleCommand 完成）。
 * customer 行保留：用户下次发消息同 #序号新建会话与新 Topic（docs/10 场景 19）。
 */
export const purgeCustomer: CommandHandler = async (ctx) => {
  const { db, bot, update } = ctx;
  const message = update.message;
  if (message === undefined) return; // classify 已保证 message 存在；防御（docs/03 判空原则）
  const from = message.from;
  if (from === undefined) return; // 白名单前置已校验存在；防御
  const text = message.text;
  if (text === undefined) return; // classify 只对 text 分流命令；防御
  const threadId = message.message_thread_id;
  if (threadId === undefined) return; // 无 thread（General/异常）不绑用户 → 静默

  // docs/04 步骤 1：thread 有映射（含重复 confirm 已清空后的幂等场景 → 静默）
  const conversation = await findCommandTargetByThread(db, bot.id, bot.support_chat_id, threadId);
  if (conversation === undefined) return;

  const customer: TitleCustomer = {
    id: conversation.customer_id,
    telegramUserId: conversation.customer_telegram_user_id,
    displayName: conversation.customer_display_name,
  };

  // parseCommand 复用 S6 解析（含 @BotName 剥离）；name 槽位已由 handler 路由保证
  const parsed = parseCommand(text);
  const invocation = parsed === null ? { confirm: false as const } : parseConfirmInvocation(parsed.args);
  if (!invocation.confirm) {
    // docs/04 步骤 2：未带 confirm → 发起段（发起审计 + 确认提示），零删除
    await initiateConfirm(ctx, AUDIT_ACTIONS.purge, from.id, threadId, customer, renderPurgeConfirmPrompt);
    return;
  }

  // docs/04 步骤 3：序号匹配 + 10 分钟窗口；拒绝路径不写执行审计、不删数据
  if (!(await validateConfirmation(ctx, AUDIT_ACTIONS.purge, threadId, customer, invocation.idToken))) {
    return;
  }

  // ── 执行（docs/04 /purge 步骤 4，顺序不可变；审计先行——先于一切删除）───────────────
  // ② audit purge（执行事件，confirmed=true；不含消息内容）
  await writeCommandAudit(db, bot.id, from.id, AUDIT_ACTIONS.purge, customer, { confirmed: true });

  // ③ 删该 conversation 全部 messages（含 media_file_id / r2_object_key 引用；Phase 3 起
  //    连带 R2 对象）——deleteMessage 只能删 48h 内消息，Telegram 侧靠 ⑤ 整题删除（docs/04）
  await deleteByConversation(db, conversation.id);

  // ④ 删 conversations 行（customer 行保留——同 #序号新会话，docs/04「customer 行保留」）
  await deleteByCustomer(db, conversation.customer_id);

  await deleteCommandMessage(ctx); // 命令消息随后删除（docs/04「命令优先级」；best-effort）

  // ⑤ deleteForumTopic（整话题删除；最后的数据删除步骤，retryable 抛出 / permanent 视为已删）
  await deleteTopicStrict(ctx, threadId);

  // ⑥ General Topic 公告（含 #序号；best-effort——审计已有记录，失败不阻断）
  await announceGeneral(ctx, renderPurgeDoneAnnouncement(customer.id));
};

/**
 * /deluser（docs/04「/deluser 流程」逐条；前置同 /purge）。
 * 与 /purge 的区别：连身份一起删除——墓碑关门先于一切删除，防「自动重建新用户」竞态；
 * 复活路径（/start → 删墓碑 → 全新 #序号 + 继承 was_watchlisted）由 S4 入站链路实现。
 */
export const delUser: CommandHandler = async (ctx) => {
  const { db, bot, update } = ctx;
  const message = update.message;
  if (message === undefined) return;
  const from = message.from;
  if (from === undefined) return;
  const text = message.text;
  if (text === undefined) return;
  const threadId = message.message_thread_id;
  if (threadId === undefined) return;

  const conversation = await findCommandTargetByThread(db, bot.id, bot.support_chat_id, threadId);
  if (conversation === undefined) return; // docs/04 步骤 1（含幂等：customer 已删 → 反查失败静默）

  const customer: TitleCustomer = {
    id: conversation.customer_id,
    telegramUserId: conversation.customer_telegram_user_id,
    displayName: conversation.customer_display_name,
  };

  const parsed = parseCommand(text);
  const invocation = parsed === null ? { confirm: false as const } : parseConfirmInvocation(parsed.args);
  if (!invocation.confirm) {
    await initiateConfirm(ctx, AUDIT_ACTIONS.deluser, from.id, threadId, customer, renderDeluserConfirmPrompt);
    return;
  }

  if (!(await validateConfirmation(ctx, AUDIT_ACTIONS.deluser, threadId, customer, invocation.idToken))) {
    return;
  }

  // ── 执行（docs/04 /deluser 执行顺序，关门先于删除，顺序不可变）─────────────────────
  // ① audit deluser（执行事件，confirmed=true）——审计先于一切删除
  await writeCommandAudit(db, bot.id, from.id, AUDIT_ACTIONS.deluser, customer, { confirmed: true });

  // ② 写墓碑（关门先于删除：此后除 /start 外一切消息被静默忽略，docs/04；
  //    was_watchlisted 取自客户当前标志、deleted_by=actor；不含任何内容数据）
  await createTombstone(db, {
    botId: bot.id,
    telegramUserId: conversation.customer_telegram_user_id,
    wasWatchlisted: conversation.customer_watchlisted === 1,
    deletedBy: from.id,
  });

  // ③ 删该 customer 名下 messages（Phase 1 每客户至多一个会话行，docs/02——当前会话即全部）
  await deleteByConversation(db, conversation.id);

  // ④ 删其全部 conversations 行
  await deleteByCustomer(db, conversation.customer_id);

  // ⑤ 删 customers 行（封禁/高危标志随行消亡；墓碑已关门）
  await deleteById(db, conversation.customer_id);

  await deleteCommandMessage(ctx); // 命令消息随后删除（docs/04「命令优先级」；best-effort）

  // ⑥ deleteForumTopic（最后的数据删除步骤；retryable 抛出 / permanent 视为已删）
  await deleteTopicStrict(ctx, threadId);

  // ⑦ General Topic 公告（含 #序号；best-effort）
  await announceGeneral(ctx, renderDeluserDoneAnnouncement(customer.id));
};
