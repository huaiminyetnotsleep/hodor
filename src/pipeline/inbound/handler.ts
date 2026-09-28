/**
 * pipeline.inbound · 入站中继（S4，docs/03「入站链路」12 步，docs/02 Topic 创建/标题规则）。
 *
 * 编排顺序（docs/03 详细步骤 4–12，触发方式无关——Webhook/Queue 共用）：
 *   查 customer → 墓碑分支（非 /start 静默；/start 复活继承 was_watchlisted）
 *   → ALLOW_UNKNOWN_USERS 门禁（docs/09：仅显式 "false" 关闭；拒绝 = 审计 + 静默 processed）
 *   → 查/建户 → blocked 静默 processed → bot_blocked_by_user 复位
 *   → 改名检测/档案刷新 → 会话 + Topic 创建编排（creating 残留 = 崩溃窗口预案）
 *   → copyMessage → messages 落库 → WELCOME（仅本次新建客户）
 *
 * 失败语义（docs/03 错误分类 + design.md 语义 9）：
 * - 主链路（查/建户、建题、copy、落库）失败 → 抛出 → inbox 5xx → Telegram 重投（至少一次）；
 *   createForumTopic 连 permanent 也抛出——creating 残留由重试路径处置（design.md 语义 4）；
 * - copyMessage permanent（400 毒丸等）→ 记 last_error + 标记 processed，不抛（重试无意义）；
 * - 副调用（WELCOME / 崩溃标记 / 审计 / 改名 editForumTopic）一律 best-effort：
 *   失败只留日志不抛出——否则整体重投会重复 copyMessage（docs/03 已知接受限制），
 *   用一条消息的送达换幂等，取舍得当（见 S4 design.md「失败语义」与本文件头注）。
 */
import { renderCrashMarker, renderWelcome } from '../../domain/copy';
import { renderDisplayName, renderTitle } from '../../domain/title';
import { markProcessed } from '../../inbox';
import {
  AUDIT_ACTIONS,
  deleteTombstone,
  findOpenByCustomer,
  findTombstone,
  findByTelegramId,
  attachTopic,
  createConversation,
  findCreatingByCustomer,
  recordMessage,
  setBotBlockedByUser,
  updateCustomerProfile,
  updateTitle,
  upsertCustomer,
  writeAudit,
} from '../../store';
import type { UpdateHandler } from '../../domain';

/**
 * ALLOW_UNKNOWN_USERS 解析（docs/09，spec/backend/env-config）：
 * 仅显式 "false" 视为关闭；缺省/其他任何值一律开放（parse, don't trust）。
 */
export function allowUnknownUsers(raw: string | undefined): boolean {
  return raw !== 'false';
}

/** 副调用兜底：失败只留日志不抛出（日志不含消息正文与 Secret，docs/09） */
async function bestEffort(stage: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[inbound] best-effort ${stage} failed:`, error instanceof Error ? error.message : error);
  }
}

export const handleInbound: UpdateHandler = async (ctx) => {
  const { db, env, bot, telegram, update } = ctx;
  const message = update.message;
  if (message === undefined) return; // classify 已保证 message 存在；防御（docs/03 判空原则）
  const from = message.from;
  if (from === undefined) return; // 无 from 无法定位用户（匿名等理论场景）→ 静默 processed

  // ── ④ 查 customer → 墓碑分支 → 未知用户门禁（docs/03 步骤 4，docs/09）────────
  const existing = await findByTelegramId(db, bot.id, from.id);
  let inheritedWatchlisted = false;
  if (existing === undefined) {
    const tombstone = await findTombstone(db, bot.id, from.id);
    if (tombstone !== undefined) {
      // 墓碑命中：仅 /start（text 以 /start 开头）可复活，其余静默 processed（docs/03/04）
      if (message.text === undefined || !message.text.startsWith('/start')) {
        return;
      }
      await deleteTombstone(db, bot.id, from.id);
      inheritedWatchlisted = tombstone.was_watchlisted === 1; // 全新 #序号 + 继承高危标志
    } else if (!allowUnknownUsers(env.ALLOW_UNKNOWN_USERS)) {
      // 未知用户且开关关闭：不建户不建题，静默 processed + 审计（docs/09）
      await writeAudit(db, {
        botId: bot.id,
        actorType: 'system',
        action: AUDIT_ACTIONS.unknownUserRejected,
        detail: { telegram_user_id: from.id },
      });
      return;
    }
  }

  // ── 查/建户（docs/03 步骤 4；upsert 返回 isNew 驱动 WELCOME）────────────────
  const displayName = renderDisplayName(from);
  const username = from.username ?? null;
  const { customer, isNew } = await upsertCustomer(db, {
    botId: bot.id,
    telegramUserId: from.id,
    displayName,
    username,
    watchlisted: inheritedWatchlisted || undefined,
  });

  // ── ⑤ blocked → 静默 processed（拒绝服务不是故障，docs/03）──────────────────
  if (customer.blocked === 1) {
    return;
  }

  // ── ⑥ 用户回归：bot_blocked_by_user 复位（恢复提示文案 S5 联调）─────────────
  if (customer.bot_blocked_by_user === 1) {
    await setBotBlockedByUser(db, customer.id, false);
  }

  // ── ⑧ 改名检测：display_name / username 漂移 → 更新档案（docs/03 步骤 8）────
  const nameChanged = customer.display_name !== displayName;
  const usernameChanged = customer.username !== username;
  if (nameChanged || usernameChanged) {
    await updateCustomerProfile(db, customer.id, displayName, username);
  }

  // 标题始终按当前库态全量重渲染（docs/02「标题规则」：绝不增量编辑旧标题）
  const title = renderTitle({
    customerId: customer.id,
    telegramUserId: customer.telegram_user_id,
    displayName,
    blocked: customer.blocked === 1,
    watchlisted: customer.watchlisted === 1,
  });

  // ── ⑦ 会话 + Topic 创建编排（docs/02 时序 + 崩溃窗口预案）───────────────────
  const open = await findOpenByCustomer(db, bot.id, customer.id);
  let conversationId: number;
  let threadId: number;
  if (open !== undefined) {
    conversationId = open.id;
    threadId = open.message_thread_id;
    if (nameChanged) {
      // 改名刷新（docs/02 刷新时机②）：editForumTopic 全量重渲染 + canonical_title 同步。
      // 副调用 best-effort：标题陈旧无害，不值得拿整条消息重投去换
      await bestEffort('editForumTopic', async () => {
        const edited = await telegram.editForumTopic({
          chatId: bot.support_chat_id,
          messageThreadId: threadId,
          name: title,
        });
        if (!edited.ok) throw new Error(edited.errorMessage ?? 'editForumTopic failed');
        await updateTitle(db, conversationId, title);
      });
    }
  } else {
    const creating = await findCreatingByCustomer(db, bot.id, customer.id);
    const isRetry = creating !== undefined; // creating 残留 = 上次创建中断（docs/02 崩溃窗口）
    conversationId =
      creating?.id ??
      (await createConversation(db, { botId: bot.id, customerId: customer.id, supportChatId: bot.support_chat_id })).id;

    // 意图已落库（creating）→ createForumTopic → 写回 thread + open（docs/02 步骤 1–4）
    const topic = await telegram.createForumTopic({ chatId: bot.support_chat_id, name: title });
    if (!topic.ok) {
      // 任何失败（含 permanent）都抛出 → inbox 5xx 重投；creating 残留由重试路径处置，
      // 重试路径即崩溃窗口预案的验证入口（design.md 语义 4/9）
      throw new Error(`createForumTopic failed (${topic.kind}): ${topic.errorMessage ?? 'unknown error'}`);
    }
    threadId = topic.result.message_thread_id;
    await attachTopic(db, conversationId, threadId, title);

    if (isRetry) {
      // 崩溃窗口预案：标记消息（#序号 + 时间戳）+ audit topic_creation_retry（docs/02，best-effort）
      await bestEffort('crash marker message', async () => {
        await telegram.sendMessage({
          chatId: bot.support_chat_id,
          messageThreadId: threadId,
          text: renderCrashMarker(customer.id, new Date().toISOString()),
        });
      });
      await bestEffort('topic_creation_retry audit', () =>
        writeAudit(db, {
          botId: bot.id,
          actorType: 'system',
          action: AUDIT_ACTIONS.topicCreationRetry,
          detail: { customer_id: customer.id, conversation_id: conversationId, message_thread_id: threadId },
        }),
      );
    }
  }

  // ── ⑨ copyMessage：from = 用户私聊 → to = (支持群, Topic)（docs/03 步骤 9，docs/02）─
  const copy = await telegram.copyMessage({
    chatId: bot.support_chat_id,
    fromChatId: message.chat.id,
    messageId: message.message_id,
    messageThreadId: threadId, // 缺省会落 General Topic（docs/10：to=(support_chat_id, message_thread_id)）
  });
  if (!copy.ok) {
    if (copy.kind === 'permanent') {
      // 400 毒丸等永久失败：重试无意义 → 记 last_error + 标记 processed（docs/03 错误分类）
      await markProcessed(db, bot.id, update.update_id, `copyMessage permanent: ${copy.errorMessage ?? 'unknown'}`);
      return;
    }
    throw new Error(`copyMessage failed (retryable): ${copy.errorMessage ?? 'unknown error'}`); // → 5xx 重投
  }

  // ── ⑩ messages 落库（docs/03 步骤 10：方向、源/目标坐标、内容类型、文本）────
  await recordMessage(db, {
    conversationId,
    direction: 'inbound',
    sourceChatId: message.chat.id,
    sourceMessageId: message.message_id,
    targetChatId: bot.support_chat_id,
    targetMessageId: copy.result.message_id,
    messageThreadId: threadId,
    message,
  });

  // ── WELCOME：仅本次新建客户（design.md 语义 7；发送失败不阻断主链路）────────
  if (isNew) {
    await bestEffort('welcome message', async () => {
      await telegram.sendMessage({ chatId: message.chat.id, text: renderWelcome(customer.id) });
    });
  }
};
