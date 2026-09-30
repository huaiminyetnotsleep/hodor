/**
 * users 表 store：用户建档、展示缓存刷新与提示频控占位。
 *
 * T19：首条消息即建档（无需 /start，无需文本——阶段 3 起媒体同权）；
 * 每次消息刷新昵称缓存与 last_seen_at。
 * T23：claimNoticeSlot 用 last_notice_at 做「每用户每分钟最多 1 次」的
 * 提示频控（欢迎语；阶段 4 起验证码 / 禁言提示复用同列）。
 *
 * 契约：治理列（status / is_banned / is_verified / …）与 first_seen_at
 * 一概不在本模块更新范围（阶段 2 契约不变）。
 */
import { isoBefore, nowIso } from "./util";

/** Telegram update 里 from 的展示字段子集（缺省字段归一为空串） */
export interface UserFromFields {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/** ensureUser 的三态返回（入站管线据此决定置顶 4b 刷新与欢迎语触发） */
export interface EnsureUserResult {
  /** 本次是否新建行（首次联系——触发欢迎语的信号之一） */
  isNew: boolean;
  /** 展示字段（first/last/username）相对库内是否有变化（触发置顶 4b 刷新） */
  displayChanged: boolean;
  /** 建档时间（users.first_seen_at；新建 = 本次 nowIso，既有行 = 首行值） */
  firstSeenAt: string;
}

/** 提示频控窗口：每用户每 60 秒最多赢得 1 个 notice slot（T23） */
export const NOTICE_SLOT_WINDOW_MS = 60_000;

/**
 * 建档 / 刷新用户行，返回三态结果。
 *
 * 先 SELECT 现行再分支（无读-判-写竞态的代价由 claimNoticeSlot 类原子
 * 语句承担；本函数只服务单 update 内的单次调用）：
 * - 无行 → INSERT（first_seen_at 显式传 nowIso，保证返回值与库内一致）
 * - 有行且展示字段变化 → 更新昵称缓存 + last_seen_at（displayChanged=true）
 * - 有行无变化 → 仅刷新 last_seen_at
 */
export async function ensureUser(
  db: D1Database,
  botId: number,
  from: UserFromFields,
): Promise<EnsureUserResult> {
  const existing = await db
    .prepare(
      "SELECT first_name, last_name, username, first_seen_at FROM users WHERE bot_id = ? AND user_id = ?",
    )
    .bind(botId, from.id)
    .first<{ first_name: string; last_name: string; username: string; first_seen_at: string }>();

  const firstName = from.first_name ?? "";
  const lastName = from.last_name ?? "";
  const username = from.username ?? "";

  if (!existing) {
    const now = nowIso();
    const firstSeenAt = now;
    await db
      .prepare(
        `INSERT INTO users (bot_id, user_id, first_name, last_name, username, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(botId, from.id, firstName, lastName, username, firstSeenAt, now)
      .run();
    return { isNew: true, displayChanged: false, firstSeenAt };
  }

  const displayChanged =
    existing.first_name !== firstName ||
    existing.last_name !== lastName ||
    existing.username !== username;
  if (displayChanged) {
    // 原阶段 2 的 upsert 更新分支：只覆盖展示缓存与活跃时间
    await db
      .prepare(
        `INSERT INTO users (bot_id, user_id, first_name, last_name, username, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, user_id) DO UPDATE SET
           first_name = excluded.first_name,
           last_name = excluded.last_name,
           username = excluded.username,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(botId, from.id, firstName, lastName, username, nowIso())
      .run();
  } else {
    await db
      .prepare("UPDATE users SET last_seen_at = ? WHERE bot_id = ? AND user_id = ?")
      .bind(nowIso(), botId, from.id)
      .run();
  }
  return { isNew: false, displayChanged, firstSeenAt: existing.first_seen_at };
}

/**
 * 原子领取提示频控 slot（T23 欢迎语频控）：
 * `last_notice_at IS NULL 或 ≤ 60 秒前` 才允许写入当前时间——单条 UPDATE
 * 的 WHERE 即裁决，**无读-判-写竞态**；meta.changes === 1 即赢得本分钟窗口。
 *
 * 新用户行 last_notice_at 为 NULL → 首条欢迎语天然赢；
 * 行不存在（理论上 ensureUser 先行，防御式）→ 0 行变更 = 输。
 */
export async function claimNoticeSlot(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET last_notice_at = ?
       WHERE bot_id = ? AND user_id = ? AND (last_notice_at IS NULL OR last_notice_at <= ?)`,
    )
    .bind(nowIso(), botId, userId, isoBefore(NOTICE_SLOT_WINDOW_MS))
    .run();
  return result.meta.changes === 1;
}
