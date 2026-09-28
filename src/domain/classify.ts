/**
 * domain · 来源分类纯函数（S3，docs/03「处理顺序总览」「忽略策略」，design.md 判定矩阵）。
 * 不依赖 IO，可独立单测；返回值即处理器注册表的路由键（handlers.ts）。
 */
import type { TelegramUpdate } from '../telegram';

export type UpdateSource = 'inbound' | 'outbound' | 'command' | 'ignore';

/** General Topic 的固定 thread id（docs/02：公告区，不绑用户） */
const GENERAL_TOPIC_THREAD_ID = 1;

/**
 * Update → 来源分类（design.md 判定矩阵，docs/03 逐条落地）：
 *
 * 1. 非 `message` 类型（edited_message / callback_query 等）→ ignore（docs/03 忽略策略）
 * 2. Bot 自身消息（from.id === bot 的 telegram_bot_id）→ ignore
 *    （docs/03：正常不会回投，此判定是防御；置于 private 判定前，杜绝任何回环路径）
 * 3. 私聊（chat.type === 'private'）→ inbound（任意类型消息均中继，docs/03 入站链路）
 * 4. 群内 message_thread_id === 1（General Topic）→ ignore
 * 5. 群消息无 text 且无 caption（服务消息：入群/置顶/Topic 创建等）→ ignore
 * 6. 群 Topic 文本以 `/` 开头 → command（命令注册表 S6 前为空 → no-op 不中继；S6 注入实现）
 * 7. 其余群 Topic 消息 → outbound（S5 出站中继：support_chat_id / thread 反查 / 白名单 /
 *    Bot 管理员身份属业务级校验，由 outbound 处理器执行，分类层不看 chat.id 与 thread）
 *
 * 业务级忽略（墓碑、未知 thread、非白名单）本层不可判定，在 S4/S5（docs/03）。
 */
export function classifyUpdate(update: TelegramUpdate, botTelegramId?: number): UpdateSource {
  const message = update.message;
  if (message === undefined) {
    return 'ignore'; // 非 message 类型
  }

  if (botTelegramId !== undefined && message.from?.id === botTelegramId) {
    return 'ignore'; // Bot 自身消息（防御）
  }

  if (message.chat.type === 'private') {
    return 'inbound';
  }

  if (message.message_thread_id === GENERAL_TOPIC_THREAD_ID) {
    return 'ignore'; // General Topic
  }

  if (message.text === undefined && message.caption === undefined) {
    return 'ignore'; // 群内服务消息（无内容字段）
  }

  if (message.text !== undefined && message.text.startsWith('/')) {
    return 'command'; // 群 Topic 命令文本（caption 不算命令）
  }

  return 'outbound'; // 其余群 Topic 消息：出站中继（S5，业务级校验在处理器）
}
