/**
 * pipeline.commands · /ban 与 /unban（S6，docs/04 十步逐条落地）。
 *
 * 单一事实源纪律（docs/04「状态唯一来源」）：封禁只写 customers.blocked；
 * conversations.status 不承载封禁语义；标题图标是 (blocked, watchlisted) 的纯派生展示
 * （docs/02：🔇 > ⚠️ > 👤，解封后恢复 ⚠️ = 解封不等于移出高危名单）。
 *
 * /ban：thread 反查 open 会话（复用 S5 store）→ setBlocked(true) → 标题全量重渲染（🔇，
 *   best-effort）→ 删命令消息（best-effort）→ audit ban。CLOSE_TOPIC_ON_BAN / BANNED_NOTICE
 *   均默认关——本任务不实现（函数内 TODO 引用 docs/04，实测项 S10 决策是否永久移除）。
 * /unban：thread 反查 open|closed 会话 → setBlocked(false) → 标题重渲染（⚠️/👤，best-effort）
 *   → status='closed' 时 reopenForumTopic + 置回 'open' → 删命令消息（best-effort）→ audit unban。
 *
 * 失败语义（docs/03 错误分类，与 inbound/outbound 同型）：
 * - 主链路（标志写入、审计）失败 → 抛出 → inbox 5xx → Telegram 重投（重放幂等：标志硬写、
 *   audit 重复行可按对账接受，与 S4 topic_creation_retry 同取舍）；
 * - 标题 editForumTopic / 命令消息删除为 best-effort（docs/04：删除失败不阻断审计与状态变更）；
 * - reopenForumTopic retryable → 抛出重投；permanent（Topic 已删除等）→ 解封已生效不阻断，
 *   会话保持 closed（下次用户入站按「无 open 会话」自然建新题，docs/02 崩溃窗口同型预案）。
 *
 * 共享辅助（删命令消息/标题重渲染/审计/best-effort）在 ./shared——S7 起 risk.ts 共用。
 */
import {
  AUDIT_ACTIONS,
  findCommandTargetByThread,
  findOpenWithCustomerByThread,
  reopenConversation,
  setBlocked,
} from '../../store';
import type { UpdateContext } from '../../domain';
import type { CommandHandler } from './registry';
import { bestEffort, deleteCommandMessage, rerenderTitle, writeCommandAudit, type TitleCustomer } from './shared';

/**
 * /ban（docs/04 十步裁剪为本仓库 Phase 1 面）。
 * 前置（白名单、支持群、解析、分发）已由 handleCommand 完成（docs/04 步骤 1–2）。
 */
export const banCustomer: CommandHandler = async (ctx: UpdateContext): Promise<void> => {
  const { db, bot, telegram, update } = ctx;
  const message = update.message;
  if (message === undefined) return; // classify 已保证 message 存在；防御（docs/03 判空原则）
  const from = message.from;
  if (from === undefined) return; // 白名单前置已校验存在；防御
  const threadId = message.message_thread_id;
  if (threadId === undefined) return; // 无 thread（General/异常）不绑用户 → 静默

  // TODO(docs/04 /ban 步骤 6): CLOSE_TOPIC_ON_BAN（默认关）——需实测 Bot 能否向 closed Topic 发消息，
  // 不通过则永久移除该选项（S10 决策）；默认关闭的另一原因：封禁期管理员仍需在 Topic 内留言存档。
  // TODO(docs/04 /ban 步骤 8): BANNED_NOTICE（默认关，docs/03 文案模板）——同上，本任务不实现。

  // 目标解析（docs/04 步骤 3）：/ban 只作用于 open 会话（封禁语义 = 阻断当前 Topic 的用户来向）
  const conversation = await findOpenWithCustomerByThread(db, bot.id, bot.support_chat_id, threadId);
  if (conversation === undefined) return; // 反查失败 → 静默（docs/04 步骤 2：未知 thread → 忽略）

  const customer: TitleCustomer = {
    id: conversation.customer_id,
    telegramUserId: conversation.customer_telegram_user_id,
    displayName: conversation.customer_display_name,
  };

  await setBlocked(db, conversation.customer_id, true); // 唯一事实源写入（docs/04 步骤 4）

  // 标题重渲染（docs/04 步骤 5：🔇 封禁优先；best-effort，docs/02 刷新时机①）
  await bestEffort('editForumTopic', () =>
    rerenderTitle(
      db,
      telegram,
      bot,
      conversation.id,
      threadId,
      customer,
      { blocked: true, watchlisted: conversation.customer_watchlisted === 1 },
    ),
  );

  await deleteCommandMessage(ctx); // docs/04 步骤 7（best-effort）

  await writeCommandAudit(db, bot.id, from.id, AUDIT_ACTIONS.ban, customer); // docs/04 步骤 9
};

/**
 * /unban（docs/04「/unban 流程」逐条）。
 * 反查放宽到 open|closed：曾 close 的 Topic 必须可命中（步骤 4 的 reopen 前提，design.md 测试⑤）。
 */
export const unbanCustomer: CommandHandler = async (ctx: UpdateContext): Promise<void> => {
  const { db, bot, telegram, update } = ctx;
  const message = update.message;
  if (message === undefined) return;
  const from = message.from;
  if (from === undefined) return;
  const threadId = message.message_thread_id;
  if (threadId === undefined) return;

  const conversation = await findCommandTargetByThread(db, bot.id, bot.support_chat_id, threadId);
  if (conversation === undefined) return; // 反查失败 → 静默（docs/04 步骤 1）

  const customer: TitleCustomer = {
    id: conversation.customer_id,
    telegramUserId: conversation.customer_telegram_user_id,
    displayName: conversation.customer_display_name,
  };

  await setBlocked(db, conversation.customer_id, false); // docs/04 步骤 2

  // 标题重渲染（docs/04 步骤 3）：⚠️ 若 watchlisted 仍在，否则 👤（解封不等于移出高危名单）
  await bestEffort('editForumTopic', () =>
    rerenderTitle(
      db,
      telegram,
      bot,
      conversation.id,
      threadId,
      customer,
      { blocked: false, watchlisted: conversation.customer_watchlisted === 1 },
    ),
  );

  // docs/04 步骤 4：曾 close 的 Topic 重开 + 置回 'open'（状态字典不含 blocked，docs/04「状态唯一来源」）
  if (conversation.status === 'closed') {
    const reopened = await telegram.reopenForumTopic({ chatId: bot.support_chat_id, messageThreadId: threadId });
    if (!reopened.ok) {
      if (reopened.kind === 'retryable') {
        // 临时故障 → 抛出 5xx 重投：整条 /unban 幂等重放（标志硬写、标题重画、reopen 重试）
        throw new Error(`reopenForumTopic failed (retryable): ${reopened.errorMessage ?? 'unknown error'}`);
      }
      // permanent（Topic 已被手动删除等）：解封本身已生效，不阻断审计；会话保持 closed——
      // 用户下次入站按「无 open 会话」自然建新题（docs/02 崩溃窗口同型预案），差异留日志供运维对账
      console.error(`[commands] reopenForumTopic failed (permanent): ${reopened.errorMessage ?? 'unknown error'}`);
    } else {
      await reopenConversation(db, conversation.id); // D1 状态不领先于 Topic 实际状态
    }
  }

  await deleteCommandMessage(ctx); // docs/04 步骤 5（best-effort）

  await writeCommandAudit(db, bot.id, from.id, AUDIT_ACTIONS.unban, customer); // docs/04 步骤 6
};
