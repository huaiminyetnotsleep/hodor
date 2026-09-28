/**
 * pipeline.outbound · 出站中继（S5，docs/03「出站链路」「用户拉黑 Bot 的 403 处理」，docs/02 反向映射）。
 *
 * 编排（docs/03 出站链路图，触发方式无关——Webhook/Queue 共用）：
 *   四重校验（任一失败 → 静默 return，不中继不落库不外呼，docs/03 忽略策略）：
 *     ① chat.id === bot.support_chat_id（classify 已保证群消息，仍显式校验）
 *     ② message_thread_id 按 (bot_id, support_chat_id, thread) 反查 open 会话（含客户信息，D1 事实源）
 *     ③ 发送者在 support_admins 白名单
 *     ④ Bot 仍是群管理员（getChatMember 经 S2 内存缓存 TTL≈5min，docs/02）
 *   → copyMessage：from = (support_chat_id, message_id)，to = 会话所属客户的 telegram_user_id
 *     （必须以 D1 为准，不得用消息上下文推断用户；to 为私聊，无 thread）
 *   → messages 落库（direction=outbound，源/目标坐标 + S4 同款内容提取）
 *
 * 失败语义（docs/03 错误分类 + design.md 出站链路 5–7）：
 * - copyMessage retryable（429 超预算/5xx/网络）→ 抛出 → inbox 5xx → Telegram 重投；
 *   getChatMember 的 retryable 失败同理（校验临时无法完成，宁可重投不可静默吞回复）；
 * - copyMessage permanent + errorCode 403 → bot_blocked_by_user 置位（0→1 才发一次性 Topic 提示，
 *   best-effort）+ 照常落库（target_message_id 落 NULL），不抛——重试无意义，标记 processed；
 *   置位非闸门：标志生效期间每次仍照常 copy（用户可能已回归），403 只驱动标志与提示；
 * - copyMessage permanent（400 毒丸等）→ 记 last_error + 标记 processed，不抛（与入站同语义）；
 * - 副调用（拉黑提示）失败只留日志不抛出——提示丢失无害，标志已置位不会重复触发。
 */
import { BOT_BLOCKED_NOTICE } from '../../domain/copy';
import { markProcessed } from '../../inbox';
import {
  findOpenWithCustomerByThread,
  findByBotAndUser,
  recordMessage,
  setBotBlockedByUser,
} from '../../store';
import { createMemberCache, type TelegramClient } from '../../telegram';
import type { UpdateHandler } from '../../domain';

/** getChatMember 内存缓存（docs/02：TTL≈5min，不每条消息打 API）；Worker 隔离实例级存活 */
const memberCache = createMemberCache();

/** 管理员/群主身份判定（design.md 校验 ④：status ∈ {administrator, creator} 才放行） */
function isPrivilegedMember(status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'): boolean {
  return status === 'administrator' || status === 'creator';
}

/**
 * Bot 在支持群的管理员身份校验（docs/02）：先查缓存，miss 时 getChatMember 并回填。
 * retryable 失败 → 抛出（5xx 重投）；permanent 失败（Bot 不在群等）→ 校验不通过。
 */
async function isBotGroupAdmin(telegram: TelegramClient, chatId: number, botTelegramId: number): Promise<boolean> {
  const cached = memberCache.get(chatId, botTelegramId);
  if (cached !== undefined) {
    return isPrivilegedMember(cached.status);
  }
  const result = await telegram.getChatMember({ chatId, userId: botTelegramId });
  if (!result.ok) {
    if (result.kind === 'retryable') {
      throw new Error(`getChatMember failed (retryable): ${result.errorMessage ?? 'unknown error'}`); // → 5xx 重投
    }
    return false; // 永久失败：无法确认管理员身份，按校验不通过静默忽略（docs/03）
  }
  memberCache.set(chatId, botTelegramId, result.result);
  return isPrivilegedMember(result.result.status);
}

/** 副调用兜底：失败只留日志不抛出（日志不含消息正文与 Secret，docs/09；与 inbound 同款） */
async function bestEffort(stage: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[outbound] best-effort ${stage} failed:`, error instanceof Error ? error.message : error);
  }
}

export const handleOutbound: UpdateHandler = async (ctx) => {
  const { db, bot, telegram, update } = ctx;
  const message = update.message;
  if (message === undefined) return; // classify 已保证 message 存在；防御（docs/03 判空原则）

  // ── ① 消息来自支持群（docs/03 校验链首环；classify 只保证是群消息）────────────
  if (message.chat.id !== bot.support_chat_id) return;

  const threadId = message.message_thread_id;
  if (threadId === undefined) return; // 无 thread（General/异常）不绑用户 → 静默（docs/02）

  // ── ② thread 反查 open 会话（含客户投递目标与拉黑标志，docs/02 反向映射）──────
  const conversation = await findOpenWithCustomerByThread(db, bot.id, bot.support_chat_id, threadId);
  if (conversation === undefined) return; // 未知 thread（管理员手建 Topic 等）→ 静默

  // ── ③ 发送者白名单（docs/03：非白名单成员静默忽略）──────────────────────────
  const from = message.from;
  if (from === undefined) return; // 匿名身份无法核对白名单 → 静默
  const admin = await findByBotAndUser(db, bot.id, from.id);
  if (admin === undefined) return;

  // ── ④ Bot 仍是群管理员（S2 缓存，docs/02）──────────────────────────────────
  if (!(await isBotGroupAdmin(telegram, bot.support_chat_id, bot.telegram_bot_id))) return;

  // ── copyMessage：from = (支持群, 消息) → to = 客户私聊（无 thread，docs/03）─────
  const copy = await telegram.copyMessage({
    chatId: conversation.customer_telegram_user_id,
    fromChatId: bot.support_chat_id,
    messageId: message.message_id,
  });

  if (!copy.ok) {
    if (copy.kind === 'permanent' && copy.errorCode === 403) {
      // 用户拉黑 Bot（docs/03）：置位 + 一次性提示 + 照常落库；不抛 → 标记 processed
      if (conversation.customer_bot_blocked_by_user === 0) {
        await setBotBlockedByUser(db, conversation.customer_id, true); // 0→1 跳变（硬写入，失败则重投重判）
        await bestEffort('bot blocked notice', async () => {
          const notice = await telegram.sendMessage({
            chatId: bot.support_chat_id,
            messageThreadId: threadId,
            text: BOT_BLOCKED_NOTICE,
          });
          if (!notice.ok) throw new Error(notice.errorMessage ?? 'sendMessage failed');
        });
      }
      // 置位期重复 403 不再提示（已为 1 无跳变）；两种情况都落库留痕（target 未送达 → NULL）
      await recordMessage(db, {
        conversationId: conversation.id,
        direction: 'outbound',
        sourceChatId: bot.support_chat_id,
        sourceMessageId: message.message_id,
        targetChatId: conversation.customer_telegram_user_id,
        messageThreadId: threadId,
        message,
      });
      return; // 标记 processed（docs/03 错误分类：403 重试无意义）
    }
    if (copy.kind === 'permanent') {
      // 400 毒丸等永久失败：重试无意义 → 记 last_error + 标记 processed（docs/03，与入站同语义）
      await markProcessed(db, bot.id, update.update_id, `copyMessage permanent: ${copy.errorMessage ?? 'unknown'}`);
      return;
    }
    throw new Error(`copyMessage failed (retryable): ${copy.errorMessage ?? 'unknown error'}`); // → 5xx 重投
  }

  // ── messages 落库（direction=outbound；目标坐标 = 客户私聊 + copy 返回的 message_id）──
  await recordMessage(db, {
    conversationId: conversation.id,
    direction: 'outbound',
    sourceChatId: bot.support_chat_id,
    sourceMessageId: message.message_id,
    targetChatId: conversation.customer_telegram_user_id,
    targetMessageId: copy.result.message_id,
    messageThreadId: threadId,
    message,
  });
};
