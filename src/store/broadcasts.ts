/**
 * broadcasts 表 store（全用户广播，2026-10-09 任务）：一份广播一行，
 * pipeline 不内联 SQL。行只存活于任务期间——终态行由 pipeline 在控制消息
 * 收尾后删除；本模块提供状态机的全部原子转移：
 *
 * preparing → pending → sending → completed（终态后删行）
 *     └────────→ cancelled / expired（终态后删行）
 * sending 崩溃滞留 → failed（陈旧判定，结果未知）
 *
 * 状态裁决全部走「UPDATE ... WHERE status='...'」原子语义（deleteConfirmations
 * 同款）：meta.changes === 1 即获胜，0 即并发方已裁决，由调用方重读分派。
 * 唯一索引约束并发：pending → sending 由「每 Bot 恰一份 sending」部分唯一索引
 * 裁决（第二个确认者撞 UNIQUE → 忙碌分支）。
 *
 * 资格语义（design §5.1，预计人数与冻结名单同语义）：topics 映射存在 +
 * users 行存在（INNER JOIN 天然排除孤儿映射）+ 未封禁；**不**按 topic status、
 * users.status（软归档）、验证态或 TTL 过滤。排序恒按 user_id 升序。
 */
import { isUniqueViolation } from "./topics";
import { nowIso } from "./util";

export type BroadcastStatus =
  | "preparing"
  | "pending"
  | "sending"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

/** broadcasts 行全列（pipeline 消费） */
export interface BroadcastRow {
  id: number;
  bot_id: number;
  source_update_id: number;
  initiator_user_id: number;
  support_chat_id: number;
  preview_msg_id: number | null;
  control_msg_id: number | null;
  message_html: string;
  recipient_ids_json: string;
  status: BroadcastStatus;
  expected_count: number;
  success_count: number;
  failure_count: number;
  expires_at: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 收件人硬上限（design §5.2）：预览/确认超限一律拒绝启动，不截断 */
export const BROADCAST_RECIPIENT_LIMIT = 500;

/** 预览有效期（R9）：创建 preparing 行时写入 expires_at，过期后须重新发起 */
export const BROADCAST_PREVIEW_TTL_MS = 5 * 60 * 1000;

/** sending 陈旧判定（design §7.2）：超过该时长视为执行中断（崩溃残留） */
export const BROADCAST_SENDING_STALE_MS = 10 * 60 * 1000;

/** 预计收件人数（确认前 COUNT；结果只标「预计」，确认时另行冻结） */
export async function countEligibleRecipients(
  db: D1Database,
  botId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM topics t
       JOIN users u ON u.bot_id = t.bot_id AND u.user_id = t.user_id
       WHERE t.bot_id = ? AND u.is_banned = 0`,
    )
    .bind(botId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 资格名单（确认冻结与发送前复核共用同一语义）：按 user_id 升序。
 * 冻结数组是本次广播的固定收件人上界；发送前再与本查询取交集剔除资格变化者。
 */
export async function listEligibleRecipients(
  db: D1Database,
  botId: number,
): Promise<number[]> {
  const result = await db
    .prepare(
      `SELECT t.user_id
       FROM topics t
       JOIN users u ON u.bot_id = t.bot_id AND u.user_id = t.user_id
       WHERE t.bot_id = ? AND u.is_banned = 0
       ORDER BY t.user_id`,
    )
    .bind(botId)
    .all<{ user_id: number }>();
  return (result.results ?? []).map((row) => row.user_id);
}

/**
 * 惰性清理（design §7.1，每次新建或确认前调用）：超过预览有效期的
 * preparing/pending 置 expired；超过陈旧窗口的 sending 置 failed
 * （视为执行中断，结果未知）。返回需完成 General 控制消息收尾的终态行，
 * 由 pipeline best-effort 编辑并删除；preparing 未有控制消息的孤儿行也会返回，
 * 供 pipeline 删除（预览消息保留为无状态孤立历史，不持有可执行任务）。
 */
export async function cleanupStaleBroadcasts(
  db: D1Database,
  botId: number,
): Promise<BroadcastRow[]> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE broadcasts SET status = 'expired', updated_at = ?
       WHERE bot_id = ? AND status IN ('preparing','pending') AND expires_at <= ?`,
    )
    .bind(now, botId, now)
    .run();
  await db
    .prepare(
      `UPDATE broadcasts SET status = 'failed', updated_at = ?
       WHERE bot_id = ? AND status = 'sending' AND updated_at <= ?`,
    )
    .bind(now, botId, new Date(Date.now() - BROADCAST_SENDING_STALE_MS).toISOString())
    .run();
  const rows = await db
    .prepare(
      `SELECT * FROM broadcasts
       WHERE bot_id = ? AND status IN ('expired','failed')
       ORDER BY id`,
    )
    .bind(botId)
    .all<BroadcastRow>();
  return rows.results ?? [];
}

/** 按 (bot_id, source_update_id) 读取（webhook 重推复用同一 preparing 行） */
export async function findBroadcastBySourceUpdate(
  db: D1Database,
  botId: number,
  sourceUpdateId: number,
): Promise<BroadcastRow | null> {
  return db
    .prepare("SELECT * FROM broadcasts WHERE bot_id = ? AND source_update_id = ?")
    .bind(botId, sourceUpdateId)
    .first<BroadcastRow>();
}

/** 按主键读取（callback 载荷只携带短 id） */
export async function findBroadcastById(
  db: D1Database,
  botId: number,
  id: number,
): Promise<BroadcastRow | null> {
  return db
    .prepare("SELECT * FROM broadcasts WHERE bot_id = ? AND id = ?")
    .bind(botId, id)
    .first<BroadcastRow>();
}

/** 当前草稿/待确认行（「同 Bot 已有广播待处理」判定的唯一依据） */
export async function findActiveDraft(
  db: D1Database,
  botId: number,
): Promise<BroadcastRow | null> {
  return db
    .prepare(
      `SELECT * FROM broadcasts
       WHERE bot_id = ? AND status IN ('preparing','pending')
       ORDER BY id LIMIT 1`,
    )
    .bind(botId)
    .first<BroadcastRow>();
}

/** 新建 preparing 行参数（message_html 为已转义冻结公告；expires_at 由调用方按 TTL 计算） */
export interface NewBroadcastRow {
  botId: number;
  sourceUpdateId: number;
  initiatorUserId: number;
  supportChatId: number;
  messageHtml: string;
  expiresAt: string;
}

/**
 * 写入新 preparing 行。冲突语义交由调用方：
 * - (bot_id, source_update_id) 撞唯一 → 同一 update 重推竞态（管线已先行
 *   查询复用，此处仅为兜底）；
 * - 撞「每 Bot 恰一份草稿」部分唯一索引 → 并发发起竞态（管线已先行查询，
 *   重推重跑会命中「已有广播待处理」分支）。
 * store 只管数据，不做补偿（topics.insertTopic 同姿态）。
 */
export async function insertPreparingBroadcast(
  db: D1Database,
  row: NewBroadcastRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO broadcasts
         (bot_id, source_update_id, initiator_user_id, support_chat_id, message_html, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.botId,
      row.sourceUpdateId,
      row.initiatorUserId,
      row.supportChatId,
      row.messageHtml,
      row.expiresAt,
    )
    .run();
}

/** 补写预览消息 ID（仍在 preparing；发送成功但落库失败的补偿语义在 pipeline） */
export async function setBroadcastPreviewMsgId(
  db: D1Database,
  botId: number,
  id: number,
  previewMsgId: number,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE broadcasts SET preview_msg_id = ?, updated_at = ?
       WHERE bot_id = ? AND id = ? AND status = 'preparing' AND preview_msg_id IS NULL`,
    )
    .bind(previewMsgId, nowIso(), botId, id)
    .run();
  if (result.meta.changes !== 1) {
    throw new Error("broadcast is no longer preparing for preview message");
  }
}

/**
 * 补写控制消息 ID 并进入 pending（按钮自此可确认；preparing → pending）。
 * 仅 preparing 行可转移（重推幂等）。
 */
export async function setBroadcastPendingWithControlMsgId(
  db: D1Database,
  botId: number,
  id: number,
  controlMsgId: number,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE broadcasts SET control_msg_id = ?, status = 'pending', updated_at = ?
       WHERE bot_id = ? AND id = ? AND status = 'preparing' AND preview_msg_id IS NOT NULL`,
    )
    .bind(controlMsgId, nowIso(), botId, id)
    .run();
  if (result.meta.changes !== 1) {
    throw new Error("broadcast is no longer preparing for control message");
  }
}

/** 原子确认结果：won = 冻结名单并进入 sending；busy = 已有发送中广播；lost = 并发方已裁决 */
export type ConfirmOutcome = "won" | "busy" | "lost";

/**
 * 原子确认（design §7.2）：pending → sending 并冻结排序 JSON 名单。
 * WHERE 同时核对 id / 发起人 / pending / 未过期——任一不满足即 0 行（lost）；
 * 「每 Bot 恰一份 sending」部分唯一索引冲突 → busy（已有广播正在发送，
 * pending 保留至自然过期）。
 */
export async function confirmBroadcast(
  db: D1Database,
  params: {
    botId: number;
    id: number;
    initiatorUserId: number;
    recipientIdsJson: string;
    expectedCount: number;
    now: string;
  },
): Promise<ConfirmOutcome> {
  try {
    const result = await db
      .prepare(
        `UPDATE broadcasts
         SET status = 'sending', recipient_ids_json = ?, expected_count = ?,
             confirmed_at = ?, updated_at = ?
         WHERE bot_id = ? AND id = ? AND initiator_user_id = ?
           AND status = 'pending' AND expires_at > ?`,
      )
      .bind(
        params.recipientIdsJson,
        params.expectedCount,
        params.now,
        params.now,
        params.botId,
        params.id,
        params.initiatorUserId,
        params.now,
      )
      .run();
    return result.meta.changes === 1 ? "won" : "lost";
  } catch (error) {
    // 唯一可能的唯一冲突来自 sending 部分唯一索引（本行状态迁移只会新增
    // sending 索引条目）→「已有广播正在发送」
    if (isUniqueViolation(error)) return "busy";
    throw error;
  }
}

/**
 * 原子取消（pending → cancelled）：与确认同款 WHERE 裁决；已过有效期的
 * pending 行不由取消转移（由过期分支处理）。
 */
export async function cancelBroadcast(
  db: D1Database,
  params: { botId: number; id: number; initiatorUserId: number; now: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE broadcasts SET status = 'cancelled', updated_at = ?
       WHERE bot_id = ? AND id = ? AND initiator_user_id = ?
         AND status = 'pending' AND expires_at > ?`,
    )
    .bind(params.now, params.botId, params.id, params.initiatorUserId, params.now)
    .run();
  return result.meta.changes === 1;
}

/** 原子过期（pending → expired）：回调命中已过期预览时的即时收敛（惰性清理同语义） */
export async function expireBroadcast(
  db: D1Database,
  botId: number,
  id: number,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE broadcasts SET status = 'expired', updated_at = ?
       WHERE bot_id = ? AND id = ? AND status = 'pending' AND expires_at <= ?`,
    )
    .bind(now, botId, id, now)
    .run();
  return result.meta.changes === 1;
}

/**
 * 完成写入（design §7.3）：一次 UPDATE 置 completed + 成功/失败总数。
 * 仅 sending 可正常完成；任务被清库或陈旧清理改为其他状态后，执行器必须
 * 停止并显示「结果未知」，不能把已取消任务误报为完整成功。
 * 0 行 = 行已被清库删除或不再处于 sending，由调用方按中断收尾。
 */
export async function completeBroadcast(
  db: D1Database,
  params: {
    botId: number;
    id: number;
    successCount: number;
    failureCount: number;
    now: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE broadcasts
       SET status = 'completed', success_count = ?, failure_count = ?, updated_at = ?
       WHERE bot_id = ? AND id = ? AND status = 'sending'`,
    )
    .bind(params.successCount, params.failureCount, params.now, params.botId, params.id)
    .run();
  return result.meta.changes === 1;
}

/**
 * /wipealldata 前置停止（design §八）：清库前将 preparing/pending 活跃行置
 * cancelled、sending 置 failed（部分收件人可能已收到，结果未知）；发送循环会在
 * 下一位收件人前观察状态并停止，当前已进入 Telegram 的单条请求无法撤回。
 */
export async function cancelActiveBroadcasts(db: D1Database, botId: number): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE broadcasts SET status = 'cancelled', updated_at = ?
       WHERE bot_id = ? AND status IN ('preparing','pending')`,
    )
    .bind(now, botId)
    .run();
  // 发送中的任务已可能向部分用户送达，不能伪标「取消（未发送）」；用 failed
  // 表示送达结果未知，并让循环在下一个收件人前观察到此状态后停止。
  await db
    .prepare(
      `UPDATE broadcasts SET status = 'failed', updated_at = ?
       WHERE bot_id = ? AND status = 'sending'`,
    )
    .bind(now, botId)
    .run();
}

/** 发送循环的清库/中断护栏；只允许任务仍处于 sending 时启动下一个私聊发送。 */
export async function isBroadcastSending(
  db: D1Database,
  botId: number,
  id: number,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS active FROM broadcasts WHERE bot_id = ? AND id = ? AND status = 'sending'")
    .bind(botId, id)
    .first<{ active: number }>();
  return row !== null;
}

/** 终态删行（控制消息收尾后调用；General 消息是唯一历史） */
export async function deleteBroadcast(db: D1Database, botId: number, id: number): Promise<void> {
  await db.prepare("DELETE FROM broadcasts WHERE bot_id = ? AND id = ?").bind(botId, id).run();
}

/**
 * 解码冻结收件人 JSON（fail-closed）：必须恰为「≤500 个正安全整数、升序、
 * 无重复」的数组；任何不符（损坏 / 被篡改 / 形态漂移）→ null，调用方绝不
 * 执行发送——绝不把任意 JSON 值当作 chat_id 发消息。
 */
export function decodeRecipientIds(json: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length > BROADCAST_RECIPIENT_LIMIT) return null;
  let previous = 0;
  for (const item of parsed) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) return null;
    if (item <= previous) return null; // 升序且无重复（严格递增）
    previous = item;
  }
  return parsed as number[];
}
