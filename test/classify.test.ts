import { describe, expect, it } from 'vitest';
import { classifyUpdate } from '../src/domain';
import type { TelegramMessage, TelegramUpdate } from '../src/telegram';

// classifyUpdate 是纯函数：无需 DB 与 workerd 语义之外的桩，直测判定矩阵（design.md 第 3 条）。

const BOT_TELEGRAM_ID = 42;
const GENERAL_THREAD = 1;
const TOPIC_THREAD = 7;
const ADMIN_ID = 900;
const USER_ID = 555000;

function msg(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 10,
    from: { id: USER_ID, is_bot: false, first_name: 'User' },
    chat: { id: -100999, type: 'supergroup' },
    date: 1760000000,
    message_thread_id: TOPIC_THREAD,
    text: 'hello',
    ...overrides,
  };
}

/** 信封构造：message 以外的互斥内容字段（edited_message 等）不声明在 TelegramUpdate 上 */
function updateOf(content: Record<string, unknown>): TelegramUpdate {
  return { update_id: 1, ...content } as TelegramUpdate;
}

describe('来源分类 · 忽略矩阵（design.md 判定矩阵，docs/03）', () => {
  it('edited_message（非 message 类型）→ ignore（docs/03：Phase 1 忽略编辑）', () => {
    expect(classifyUpdate(updateOf({ edited_message: msg() }), BOT_TELEGRAM_ID)).toBe('ignore');
  });

  it('channel_post / 无 message 的信封（callback_query 等）→ ignore', () => {
    expect(classifyUpdate(updateOf({ channel_post: msg() }), BOT_TELEGRAM_ID)).toBe('ignore');
    expect(classifyUpdate(updateOf({}), BOT_TELEGRAM_ID)).toBe('ignore');
  });

  it('私聊文本 → inbound', () => {
    const update = updateOf({ message: msg({ chat: { id: USER_ID, type: 'private' } }) });
    expect(classifyUpdate(update, BOT_TELEGRAM_ID)).toBe('inbound');
  });

  it('私聊媒体（caption、无 text）→ inbound（docs/03：任意类型均中继）', () => {
    const update = updateOf({
      message: msg({ chat: { id: USER_ID, type: 'private' }, text: undefined, caption: 'photo caption' }),
    });
    expect(classifyUpdate(update, BOT_TELEGRAM_ID)).toBe('inbound');
  });

  it('私聊服务消息（无 text/caption）→ inbound（private 判定优先于服务消息规则）', () => {
    const update = updateOf({ message: msg({ chat: { id: USER_ID, type: 'private' }, text: undefined }) });
    expect(classifyUpdate(update, BOT_TELEGRAM_ID)).toBe('inbound');
  });

  it('Bot 自身消息 → ignore（防御判定置于 private 之前，杜绝回环；docs/03：正常不回投）', () => {
    const selfPrivate = updateOf({
      message: msg({
        from: { id: BOT_TELEGRAM_ID, is_bot: true, first_name: 'hodor' },
        chat: { id: BOT_TELEGRAM_ID, type: 'private' },
      }),
    });
    expect(classifyUpdate(selfPrivate, BOT_TELEGRAM_ID)).toBe('ignore');

    const selfGroup = updateOf({
      message: msg({ from: { id: BOT_TELEGRAM_ID, is_bot: true, first_name: 'hodor' } }),
    });
    expect(classifyUpdate(selfGroup, BOT_TELEGRAM_ID)).toBe('ignore');
  });

  it('未传 botTelegramId 时不做 Bot 自身判定：同一条私聊消息照常 inbound', () => {
    const update = updateOf({
      message: msg({
        from: { id: BOT_TELEGRAM_ID, is_bot: true, first_name: 'hodor' },
        chat: { id: BOT_TELEGRAM_ID, type: 'private' },
      }),
    });
    expect(classifyUpdate(update)).toBe('inbound');
  });

  it('General Topic（message_thread_id === 1）→ ignore，/ 前缀也不进命令（docs/02：公告区不绑用户）', () => {
    expect(classifyUpdate(updateOf({ message: msg({ message_thread_id: GENERAL_THREAD }) }), BOT_TELEGRAM_ID)).toBe(
      'ignore',
    );
    expect(
      classifyUpdate(updateOf({ message: msg({ message_thread_id: GENERAL_THREAD, text: '/ban 5' }) }), BOT_TELEGRAM_ID),
    ).toBe('ignore');
  });

  it('群 Topic 服务消息（无 text 且无 caption）→ ignore（入群/置顶/Topic 创建等）', () => {
    expect(classifyUpdate(updateOf({ message: msg({ text: undefined }) }), BOT_TELEGRAM_ID)).toBe('ignore');
  });

  it('群 Topic / 前缀文本 → command（匿名身份 from 缺失同样成立）', () => {
    expect(
      classifyUpdate(updateOf({ message: msg({ from: { id: ADMIN_ID, is_bot: false, first_name: 'Admin' }, text: '/ban 5' }) }), BOT_TELEGRAM_ID),
    ).toBe('command');
    expect(classifyUpdate(updateOf({ message: msg({ from: undefined, text: '/purge 3' }) }), BOT_TELEGRAM_ID)).toBe(
      'command',
    );
  });

  it('群 Topic 普通文本 → ignore（S5 出站占位同 ignore 处理，design.md）', () => {
    const update = updateOf({
      message: msg({ from: { id: ADMIN_ID, is_bot: false, first_name: 'Admin' }, text: 'please help' }),
    });
    expect(classifyUpdate(update, BOT_TELEGRAM_ID)).toBe('ignore');
  });

  it('群 Topic 媒体（caption）→ ignore；caption 以 / 开头也不构成命令（命令只认 text）', () => {
    expect(classifyUpdate(updateOf({ message: msg({ text: undefined, caption: 'photo' }) }), BOT_TELEGRAM_ID)).toBe(
      'ignore',
    );
    expect(
      classifyUpdate(updateOf({ message: msg({ text: undefined, caption: '/not-a-command' }) }), BOT_TELEGRAM_ID),
    ).toBe('ignore');
  });

  it('普通群（chat.type = group）同矩阵：/ 前缀 → command、无内容 → ignore', () => {
    const groupChat = { id: -200999, type: 'group' as const };
    expect(
      classifyUpdate(updateOf({ message: msg({ chat: groupChat, text: '/unban 5' }) }), BOT_TELEGRAM_ID),
    ).toBe('command');
    expect(classifyUpdate(updateOf({ message: msg({ chat: groupChat, text: undefined }) }), BOT_TELEGRAM_ID)).toBe(
      'ignore',
    );
  });

  it('无 message_thread_id 的群消息按矩阵余项处理（thread 校验属 S5/S6 业务层）', () => {
    expect(
      classifyUpdate(updateOf({ message: msg({ message_thread_id: undefined, text: 'hi' }) }), BOT_TELEGRAM_ID),
    ).toBe('ignore');
    expect(
      classifyUpdate(updateOf({ message: msg({ message_thread_id: undefined, text: '/cmd' }) }), BOT_TELEGRAM_ID),
    ).toBe('command');
  });
});
