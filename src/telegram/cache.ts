/**
 * telegram · getChatMember 内存缓存（S2，docs/02「Bot 在支持群的权限」）。
 *
 * 出站链路每条消息都要校验 Bot 管理员身份，但 getChatMember 不必每条消息都打一次
 * Bot API——docs/02 要求结果做内存缓存（TTL ≈ 5 分钟）；KV 缓存是 Phase 2+（docs/07）。
 *
 * LRU 实现：Map 插入序即使用序，命中时删了重插刷新位置；容量超限淘汰最久未用。
 * key = `${chatId}:${userId}`（design.md 契约）。与 client 解耦，由调用方组合
 * （先查缓存，miss 时 getChatMember 后 set）。
 */
import type { TelegramChatMember } from './types';

/** TTL ≈ 5 分钟（docs/02） */
const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** 容量上限 500 条（design.md） */
const DEFAULT_CAPACITY = 500;

export interface MemberCache {
  get(chatId: number | string, userId: number): TelegramChatMember | undefined;
  set(chatId: number | string, userId: number, member: TelegramChatMember): void;
}

interface CacheEntry {
  expiresAt: number;
  member: TelegramChatMember;
}

export function createMemberCache(ttlMs: number = DEFAULT_TTL_MS, capacity: number = DEFAULT_CAPACITY): MemberCache {
  const entries = new Map<string, CacheEntry>();

  const keyOf = (chatId: number | string, userId: number): string => `${chatId}:${userId}`;

  return {
    get(chatId, userId) {
      const key = keyOf(chatId, userId);
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (Date.now() >= entry.expiresAt) {
        entries.delete(key); // 过期即清，避免死条目长期占位
        return undefined;
      }
      // LRU touch：删了重插，把命中条目移到最新位置
      entries.delete(key);
      entries.set(key, entry);
      return entry.member;
    },

    set(chatId, userId, member) {
      const key = keyOf(chatId, userId);
      entries.delete(key); // 同 key 重复 set 时刷新位置与过期时间
      entries.set(key, { expiresAt: Date.now() + ttlMs, member });
      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done) break; // 防御 capacity < 0 的极端入参，避免死循环
        entries.delete(oldest.value);
      }
    },
  };
}
