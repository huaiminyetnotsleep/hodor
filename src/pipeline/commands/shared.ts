/**
 * pipeline.commands · 命令处理器共享辅助（S6 落地，S7 起 risk.ts 共用——code-reuse：
 * 命令族共用「删命令消息 / 标题重渲染 / 审计 / best-effort 兜底」，单点定义禁止复制）。
 *
 * 全部遵循 docs/04 命令步序与 docs/03 错误分类：
 * - 副调用（标题 editForumTopic、命令消息删除、置位提示）best-effort——失败只留日志，
 *   不阻断状态变更与审计（docs/04：删除失败不阻断审计与状态变更）；
 * - 标题始终按 DB 当前状态全量重渲染（docs/02：绝不在旧标题上增删字符串）；
 * - 审计 detail 不含敏感值与消息内容（docs/06）。
 */
import { renderTitle } from '../../domain/title';
import { updateTitle, writeAudit, type AuditAction, type Bot } from '../../store';
import type { AUDIT_ACTIONS } from '../../store';
import type { TelegramClient } from '../../telegram';
import type { UpdateContext } from '../../domain';

/** 副调用兜底（与 inbound/outbound 同款）：失败只留日志不抛出（docs/09：日志不含正文与 Secret） */
export async function bestEffort(stage: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[commands] best-effort ${stage} failed:`, error instanceof Error ? error.message : error);
  }
}

/**
 * 删除命令消息（docs/04 /ban 步骤 7、/unban 步骤 5、/risk /unrisk；best-effort——
 * 删除失败不阻断审计与状态变更）。由各命令处理器在目标解析成功后调用（docs/04：
 * 未知 thread 等忽略分支先于删除，失败的命令不留「消息消失但什么都没发生」的假象，design.md 测试⑧）。
 */
export async function deleteCommandMessage(ctx: UpdateContext): Promise<void> {
  const message = ctx.update.message;
  if (message === undefined) return; // 防御：调用链已保证存在
  await bestEffort('deleteMessage', async () => {
    const deleted = await ctx.telegram.deleteMessage({
      chatId: ctx.bot.support_chat_id,
      messageId: message.message_id,
    });
    if (!deleted.ok) {
      throw new Error(deleted.errorMessage ?? 'deleteMessage failed');
    }
  });
}

/** 标题渲染的客户档案投影（display_name 可空时由渲染层回退 telegram_user_id，docs/03 判空） */
export interface TitleCustomer {
  id: number;
  telegramUserId: number;
  displayName: string | null;
}

/**
 * 标题重渲染（docs/02：始终按 DB 当前状态全量重画，绝不在旧标题上增删）+ canonical_title 同步。
 * 抛错由调用方包 best-effort 吞掉；canonical_title 仅在 editForumTopic 成功后推进（与 inbound 一致）。
 */
export async function rerenderTitle(
  db: D1Database,
  telegram: TelegramClient,
  bot: Bot,
  conversationId: number,
  threadId: number,
  customer: TitleCustomer,
  flags: { blocked: boolean; watchlisted: boolean },
): Promise<void> {
  const title = renderTitle({
    customerId: customer.id,
    telegramUserId: customer.telegramUserId,
    displayName: customer.displayName ?? String(customer.telegramUserId),
    blocked: flags.blocked,
    watchlisted: flags.watchlisted,
  });
  const edited = await telegram.editForumTopic({ chatId: bot.support_chat_id, messageThreadId: threadId, name: title });
  if (!edited.ok) {
    throw new Error(edited.errorMessage ?? 'editForumTopic failed');
  }
  await updateTitle(db, conversationId, title);
}

/** 命令族审计 action 白名单（ban/unban S6、risk/unrisk S7、purge/deluser S8——docs/06 action 全集的命令子集） */
export type AdminCommandAction = Extract<
  AuditAction,
  | typeof AUDIT_ACTIONS.ban
  | typeof AUDIT_ACTIONS.unban
  | typeof AUDIT_ACTIONS.risk
  | typeof AUDIT_ACTIONS.unrisk
  | typeof AUDIT_ACTIONS.purge
  | typeof AUDIT_ACTIONS.deluser
>;

/**
 * 命令审计单点（docs/04：actor = 发送者、target = customer；detail 不含敏感值与消息内容）。
 * extra 供 S8 危险命令的执行事件携带 confirmed=true（发起/执行两次审计共用本单点，docs/04 审计先行）。
 */
export async function writeCommandAudit(
  db: D1Database,
  botId: number,
  actorTelegramUserId: number,
  action: AdminCommandAction,
  customer: TitleCustomer,
  extra?: Record<string, unknown>,
): Promise<void> {
  await writeAudit(db, {
    botId,
    actorType: 'admin',
    actorId: actorTelegramUserId,
    action,
    detail: { customer_id: customer.id, telegram_user_id: customer.telegramUserId, ...extra },
  });
}
