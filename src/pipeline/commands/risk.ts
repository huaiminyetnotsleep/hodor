/**
 * pipeline.commands · /risk 与 /unrisk（S7，docs/04「/risk / /unrisk 流程」）。
 *
 * 单一事实源纪律（docs/04「状态唯一来源」）：高危名单只写 customers.watchlisted，
 * 与 blocked 正交独立（docs/04「正交独立」：/risk 不改 blocked、可被 /ban 叠加；
 * /unban 不改 watchlisted——解封 ≠ 移出名单）；标题图标是 (blocked, watchlisted) 的
 * 纯派生展示（docs/02：🔇 > ⚠️ > 👤，/risk 对已封禁用户保持 🔇）。
 *
 * /risk：thread 反查 open|closed 会话 → setWatchlisted(true) → 标题重渲染（未 blocked → ⚠️）
 *   → 置位提示一次（RISK_SET_NOTICE 发进本 Topic，best-effort）→ 删命令消息（best-effort）
 *   → audit risk。
 * /unrisk：setWatchlisted(false) → 标题重渲染（⚠️ 消失）→ 删命令消息（best-effort）
 *   → audit unrisk（无解除提示，docs/04 未要求）。
 *
 * 失败语义与 ban.ts 同型（docs/03 错误分类）：主链路（标志写入、审计）失败 → 抛出 →
 * inbox 5xx → Telegram 重投（标志硬写幂等）；标题/置位提示/删消息 best-effort。
 */
import { RISK_SET_NOTICE } from '../../domain/copy';
import { AUDIT_ACTIONS, findCommandTargetByThread, setWatchlisted } from '../../store';
import type { UpdateContext } from '../../domain';
import type { CommandHandler } from './registry';
import { bestEffort, deleteCommandMessage, rerenderTitle, writeCommandAudit, type TitleCustomer } from './shared';

/**
 * /risk（docs/04「/risk 流程」逐条）。
 * 前置（白名单、支持群、解析、分发）已由 handleCommand 完成（docs/04 步骤 1–2）；
 * 反查 open|closed：高危标记与会话生命周期无关（closed Topic 同样可标记）。
 */
export const riskCustomer: CommandHandler = async (ctx: UpdateContext): Promise<void> => {
  const { db, bot, telegram, update } = ctx;
  const message = update.message;
  if (message === undefined) return; // classify 已保证 message 存在；防御（docs/03 判空原则）
  const from = message.from;
  if (from === undefined) return; // 白名单前置已校验存在；防御
  const threadId = message.message_thread_id;
  if (threadId === undefined) return; // 无 thread（General/异常）不绑用户 → 静默

  const conversation = await findCommandTargetByThread(db, bot.id, bot.support_chat_id, threadId);
  if (conversation === undefined) return; // 反查失败 → 静默（docs/04 步骤 2：未知 thread → 忽略）

  const customer: TitleCustomer = {
    id: conversation.customer_id,
    telegramUserId: conversation.customer_telegram_user_id,
    displayName: conversation.customer_display_name,
  };

  await setWatchlisted(db, conversation.customer_id, true); // 唯一事实源写入（docs/04 步骤 1）

  // 标题重渲染（docs/04 步骤 2：⚠️；blocked 时 🔇 保持——封禁优先，docs/02）
  await bestEffort('editForumTopic', () =>
    rerenderTitle(
      db,
      telegram,
      bot,
      conversation.id,
      threadId,
      customer,
      { blocked: conversation.customer_blocked === 1, watchlisted: true },
    ),
  );

  // 置位提示一次（docs/04 步骤 3：立即在本 Topic 发一条置位提示；best-effort）
  await bestEffort('risk set notice', async () => {
    const notice = await telegram.sendMessage({
      chatId: bot.support_chat_id,
      messageThreadId: threadId,
      text: RISK_SET_NOTICE,
    });
    if (!notice.ok) throw new Error(notice.errorMessage ?? 'sendMessage failed');
  });

  await deleteCommandMessage(ctx); // docs/04 步骤 4（best-effort）

  await writeCommandAudit(db, bot.id, from.id, AUDIT_ACTIONS.risk, customer); // docs/04 步骤 4
};

/**
 * /unrisk（docs/04：对称流程——watchlisted=0、标题移除 ⚠️、audit unrisk）。
 * 反查 open|closed 同 /risk；无解除提示（docs/04 未要求）。
 */
export const unriskCustomer: CommandHandler = async (ctx: UpdateContext): Promise<void> => {
  const { db, bot, telegram, update } = ctx;
  const message = update.message;
  if (message === undefined) return;
  const from = message.from;
  if (from === undefined) return;
  const threadId = message.message_thread_id;
  if (threadId === undefined) return;

  const conversation = await findCommandTargetByThread(db, bot.id, bot.support_chat_id, threadId);
  if (conversation === undefined) return; // 反查失败 → 静默（docs/04）

  const customer: TitleCustomer = {
    id: conversation.customer_id,
    telegramUserId: conversation.customer_telegram_user_id,
    displayName: conversation.customer_display_name,
  };

  await setWatchlisted(db, conversation.customer_id, false); // 唯一事实源写入

  // 标题重渲染：⚠️ 消失；blocked 时仍 🔇（两标志独立，docs/02 优先级）
  await bestEffort('editForumTopic', () =>
    rerenderTitle(
      db,
      telegram,
      bot,
      conversation.id,
      threadId,
      customer,
      { blocked: conversation.customer_blocked === 1, watchlisted: false },
    ),
  );

  await deleteCommandMessage(ctx); // best-effort

  await writeCommandAudit(db, bot.id, from.id, AUDIT_ACTIONS.unrisk, customer);
};
