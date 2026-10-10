/**
 * users 表 store：用户建档、展示缓存刷新、提示频控与治理门控原语。
 *
 * 首条消息即建档（无需 /start，文本与媒体同权）；
 * 每次消息刷新昵称缓存与 last_seen_at。
 * claimNoticeSlot 用 last_notice_at 做「每用户每分钟最多 1 次」的
 * 提示频控（欢迎语 / 验证码 / 禁言 / 超限提示共用同列）。
 * ensureUser 的既有 SELECT 顺带读出治理快照
 * （封禁 / 验证 / 题目字段）；验证态、封禁态与限频窗口的全部变更收口在
 * 本模块的专用原子 setter / 计数器——流水线绝不手写治理列 UPDATE。
 * 快照顺带读出 is_risk / verified_at（高危提醒与
 * TTL 判定的数据源）；setRisk / claimRiskNoticeSlot（24 小时一次性
 * 提醒窗口）；clearAllPendingVerifications（/verifymode 切换作废旧题）。
 *
 * 契约：first_seen_at 永不在本模块更新范围（建档即定死）；展示列刷新仅走
 * ensureUser；治理列变更仅走本模块 setter（单语句原子，无读-判-写竞态）。
 */
import { isoBefore, nowIso } from "./util";
import type { VerifyMode } from "./settings";

/** Telegram update 里 from 的展示字段子集（缺省字段归一为空串） */
export interface UserFromFields {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * 治理快照：三门判定（封禁 / 验证）+ 答题归属（pending 题目字段）+
 * 置顶刷新所需的展示列。ensureUser 与 getGovernanceSnapshot 共用此形状。
 */
export interface GovernanceSnapshot {
  /** 封禁门：is_banned=1 → 入站一律拦截（先于验证 / 限频门） */
  isBanned: boolean;
  /** 验证门：is_verified=0 → 拦截并（按策略）出验证题 */
  isVerified: boolean;
  /**
   * 高危标记（users.is_risk）：置顶「高危」行与 topic 内 24 小时一次性
   * 提醒（claimRiskNoticeSlot）的数据源
   */
  isRisk: boolean;
  /**
   * 验证通过时间（users.verified_at）：VERIFY_TTL_HOURS 过期判定用
   * （字典序比较，util 契约）；未验证 / 已撤销 → null
   */
  verifiedAt: string | null;
  /** 当前 pending 题的正确答案（users.verify_answer；无题 → null） */
  verifyAnswer: number | null;
  /** 当前 pending 题的题面消息 ID（users.verify_msg_id；无题 → null） */
  verifyMsgId: number | null;
  /**
   * 当前挑战的请求身份摘要（users.verify_request_hash；无有效挑战 → null）：
   * 三模式共用栅栏。NULL = 无挑战或已被清空（升级前的旧 pending 也视为失效）——
   * 答题回调预检 / 最终 CAS 都要求非空且与本轮回调所见的挑战一致。
   */
  verifyRequestHash: string | null;
  /** 当前挑战的配置版本快照（users.verify_request_generation；无挑战 → null） */
  verifyRequestGeneration: number | null;
  firstName: string;
  lastName: string;
  username: string;
  /** 建档时间（users.first_seen_at，ISO 文本）——置顶信息展示用 */
  firstSeenAt: string;
}

/** ensureUser 的返回（入站管线据此走三门与置顶 4b 刷新 / 欢迎语触发） */
export interface EnsureUserResult extends GovernanceSnapshot {
  /** 本次是否新建行（首次联系——首联包：欢迎语 + 首个验证题成对发出） */
  isNew: boolean;
  /** 展示字段（first/last/username）相对库内是否有变化（触发置顶 4b 刷新） */
  displayChanged: boolean;
}

/** 提示频控窗口：每用户每 60 秒最多赢得 1 个 notice slot */
export const NOTICE_SLOT_WINDOW_MS = 60_000;

/** 限频固定窗口长度：距 rate_window_start ≥ 60s 即重置计数 */
export const RATE_WINDOW_MS = 60_000;

/** 高危提醒窗口：同一高危用户 24 小时内最多提醒 1 次 */
export const RISK_NOTICE_WINDOW_MS = 24 * 3600_000;

/**
 * 建档 / 刷新用户行，返回三态结果 + 治理快照。
 *
 * 先 SELECT 现行再分支（无读-判-写竞态的代价由 claimNoticeSlot 类原子
 * 语句承担；本函数只服务单 update 内的单次调用）：
 * - 无行 → INSERT（first_seen_at 显式传 nowIso，保证返回值与库内一致）；
 *   治理快照即建档默认值（未封禁 / 未验证 / 无题）
 * - 有行且展示字段变化 → 更新昵称缓存 + last_seen_at（displayChanged=true）
 * - 有行无变化 → 仅刷新 last_seen_at
 * 治理列（is_banned / is_verified / verify_*）在两个更新分支均不触碰。
 */
export async function ensureUser(
  db: D1Database,
  botId: number,
  from: UserFromFields,
): Promise<EnsureUserResult> {
  const existing = await db
    .prepare(
      `SELECT first_name, last_name, username, first_seen_at, is_banned, is_verified,
         is_risk, verified_at, verify_answer, verify_msg_id,
         verify_request_hash, verify_request_generation
       FROM users WHERE bot_id = ? AND user_id = ?`,
    )
    .bind(botId, from.id)
    .first<{
      first_name: string;
      last_name: string;
      username: string;
      first_seen_at: string;
      is_banned: number;
      is_verified: number;
      is_risk: number;
      verified_at: string | null;
      verify_answer: number | null;
      verify_msg_id: number | null;
      verify_request_hash: string | null;
      verify_request_generation: number | null;
    }>();

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
    return {
      isNew: true,
      displayChanged: false,
      firstSeenAt,
      isBanned: false,
      isVerified: false,
      isRisk: false,
      verifiedAt: null,
      verifyAnswer: null,
      verifyMsgId: null,
      verifyRequestHash: null,
      verifyRequestGeneration: null,
      firstName,
      lastName,
      username,
    };
  }

  const displayChanged =
    existing.first_name !== firstName ||
    existing.last_name !== lastName ||
    existing.username !== username;
  if (displayChanged) {
    // upsert 更新分支：只覆盖展示缓存与活跃时间
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
  return {
    isNew: false,
    displayChanged,
    firstSeenAt: existing.first_seen_at,
    isBanned: existing.is_banned === 1,
    isVerified: existing.is_verified === 1,
    isRisk: existing.is_risk === 1,
    verifiedAt: existing.verified_at,
    verifyAnswer: existing.verify_answer,
    verifyMsgId: existing.verify_msg_id,
    verifyRequestHash: existing.verify_request_hash,
    verifyRequestGeneration: existing.verify_request_generation,
    // 展示列回读「写后真值」：displayChanged 分支刚把新值写入库，
    // 快照与库内保持一致（而非 SELECT 时的旧值）
    firstName,
    lastName,
    username,
  };
}

/**
 * 只读治理快照（答题回调用，无副作用）：行不存在 → null。
 * 与 ensureUser 同一列集——答题归属判定（verify_msg_id）与置顶刷新
 * （展示列 + first_seen_at）一次读齐。
 */
export async function getGovernanceSnapshot(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<GovernanceSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT first_name, last_name, username, first_seen_at, is_banned, is_verified,
         is_risk, verified_at, verify_answer, verify_msg_id,
         verify_request_hash, verify_request_generation
       FROM users WHERE bot_id = ? AND user_id = ?`,
    )
    .bind(botId, userId)
    .first<{
      first_name: string;
      last_name: string;
      username: string;
      first_seen_at: string;
      is_banned: number;
      is_verified: number;
      is_risk: number;
      verified_at: string | null;
      verify_answer: number | null;
      verify_msg_id: number | null;
      verify_request_hash: string | null;
      verify_request_generation: number | null;
    }>();
  if (!row) return null;
  return {
    isBanned: row.is_banned === 1,
    isVerified: row.is_verified === 1,
    isRisk: row.is_risk === 1,
    verifiedAt: row.verified_at,
    verifyAnswer: row.verify_answer,
    verifyMsgId: row.verify_msg_id,
    verifyRequestHash: row.verify_request_hash,
    verifyRequestGeneration: row.verify_request_generation,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    firstSeenAt: row.first_seen_at,
  };
}

/**
 * 原子领取提示频控 slot（全部 bot → 用户提示共享）：
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

/**
 * 原子领取高危提醒 slot：完全复刻 claimNoticeSlot 的原子模式——
 * 单条 UPDATE 的 WHERE 即裁决，**无读-判-写竞态**；meta.changes === 1 即
 * 赢得本 24 小时窗口（赢者负责发送 topic 内提醒）。
 *
 * WHERE 额外带 `is_risk = 1`：非高危（含 /unrisk 之后）永不赢得，调用方
 * 无需先判快照；`risk_notice_at IS NULL 或 ≤ 24 小时前` 才允许写入当前
 * 时间——NULL 即「从未提醒」，首条消息天然赢。/risk 重新标记时 setter
 * 已清空本列，窗口随之重置（下一条消息再提醒一次）。
 */
export async function claimRiskNoticeSlot(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET risk_notice_at = ?
       WHERE bot_id = ? AND user_id = ?
         AND is_risk = 1 AND (risk_notice_at IS NULL OR risk_notice_at <= ?)`,
    )
    .bind(nowIso(), botId, userId, isoBefore(RISK_NOTICE_WINDOW_MS))
    .run();
  return result.meta.changes === 1;
}

/**
 * 落库 pending 验证题（流水线不再使用——出题走
 * reserveVerificationRequest + attachVerifyMessage 的统一栅栏 CAS。本函数仅
 * 保留给测试播种 / 兼容场景：无条件覆盖 answer + msgId，不改栅栏四列）。
 */
export async function setPendingVerification(
  db: D1Database,
  botId: number,
  userId: number,
  params: { answer: number; msgId: number },
): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET verify_answer = ?, verify_msg_id = ? WHERE bot_id = ? AND user_id = ?",
    )
    .bind(params.answer, params.msgId, botId, userId)
    .run();
}

/**
 * 标记验证通过（仅测试播种 / 兼容保留——流水线的两条最终裁决
 * 走 completeCallbackVerification / completeTurnstileVerification 的条件 CAS）：
 * `is_verified 0→1 + verified_at + 清空题目字段与 Turnstile 四列`，
 * WHERE 带 `is_verified = 0` 使「是否发生转换」可辨（幂等重放返回 false）。
 */
export async function markVerified(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users
       SET is_verified = 1, verified_at = ?, verify_answer = NULL, verify_msg_id = NULL,
           verify_request_hash = NULL, verify_request_expires_at = NULL,
           verify_request_generation = NULL, verify_submit_not_before = NULL
       WHERE bot_id = ? AND user_id = ? AND is_verified = 0`,
    )
    .bind(nowIso(), botId, userId)
    .run();
  return result.meta.changes === 1;
}

/**
 * 撤销验证态（超限重验 / 归档统一入口）：is_verified=0 + 清 verified_at
 * 与题目字段 + Turnstile 四列（归档 / TTL / 超限后不得残留任何可完成的挑战）。
 * 不动限频列——窗口重置由 countMessageInWindow 按时间自行判定。
 */
export async function markUnverified(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET is_verified = 0, verified_at = NULL, verify_answer = NULL, verify_msg_id = NULL,
           verify_request_hash = NULL, verify_request_expires_at = NULL,
           verify_request_generation = NULL, verify_submit_not_before = NULL
       WHERE bot_id = ? AND user_id = ?`,
    )
    .bind(botId, userId)
    .run();
}

/**
 * 作废全部 pending 验证挑战（Turnstile 任务起含义扩展为「全部 pending」）：
 * 一次性清空所有行的题目字段与 Turnstile 四列（存在任一 pending 迹象才产生
 * 行变更——无 pending 行零变更，幂等）。
 *
 * 旧题回调 / 网页旧请求的最终裁决全部带 verify_request_hash 条件，被清空的
 * 旧挑战（hash=NULL）天然落「已失效」分支——「旧挑战不能误通过」的实现根基。
 * 题目字段与验证态（is_verified / verified_at）互不相干：已验证用户不受影响。
 */
export async function clearAllPendingVerifications(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET
         verify_answer = NULL, verify_msg_id = NULL,
         verify_request_hash = NULL, verify_request_expires_at = NULL,
         verify_request_generation = NULL, verify_submit_not_before = NULL
       WHERE verify_msg_id IS NOT NULL OR verify_request_hash IS NOT NULL`,
    )
    .run();
}

/** 封禁 / 解禁：/ban /unban 命令的唯一写入口。
 *
 * /ban 在同一 UPDATE 内原子清空全部 pending 字段（题目 + Turnstile 四列）：
 * 不清 hash 的话 ban→unban 会让旧挑战（旧网页链接 / 旧题面）在解封后满足
 * 完成条件而复活——清了就永久失效，解封用户由下一条消息重新出题。
 * 解封不恢复任何字段（幂等 setter，重推安全）。
 */
export async function setBanned(
  db: D1Database,
  botId: number,
  userId: number,
  banned: boolean,
): Promise<void> {
  await db
    .prepare(
      banned
        ? `UPDATE users SET
             is_banned = 1,
             verify_answer = NULL, verify_msg_id = NULL,
             verify_request_hash = NULL, verify_request_expires_at = NULL,
             verify_request_generation = NULL, verify_submit_not_before = NULL
           WHERE bot_id = ? AND user_id = ?`
        : "UPDATE users SET is_banned = 0 WHERE bot_id = ? AND user_id = ?",
    )
    .bind(botId, userId)
    .run();
}

/**
 * 置用户 deleted 态（/archive 的 DB 状态之一）：表示软归档，不删除 users 行，
 * 也不参与验证门判定；验证态由 markUnverified 单独清理。物理 /deluser 会删行。幂等 setter。
 */
export async function markUserDeleted(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare("UPDATE users SET status = 'deleted' WHERE bot_id = ? AND user_id = ?")
    .bind(botId, userId)
    .run();
}

/**
 * 复位用户 active 态（重开链路）：resolveTopic 重开 closed 行时的唯一
 * 复位点（与 reopenTopic 成对），ensureUser 永不触碰 status 列（契约不变）。
 */
export async function markUserActive(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare("UPDATE users SET status = 'active' WHERE bot_id = ? AND user_id = ?")
    .bind(botId, userId)
    .run();
}

/**
 * 高危标记 / 取消：/risk /unrisk 命令的唯一写入口。
 *
 * 单语句同时写 is_risk 与 risk_notice_at = NULL：置 1 清窗口使该用户
 * **下一条消息重新提醒一次**（重新标记 → 提示窗口重置）；
 * 置 0 一并清——行内不留悬空窗口（再 /risk 语义与首次标记完全一致）。
 */
export async function setRisk(
  db: D1Database,
  botId: number,
  userId: number,
  risk: boolean,
): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET is_risk = ?, risk_notice_at = NULL WHERE bot_id = ? AND user_id = ?",
    )
    .bind(risk ? 1 : 0, botId, userId)
    .run();
}

/**
 * 限频固定窗口计数：窗口内第 1..N 条放行，第 N+1 条拦截。
 *
 * 两条原子语句实现：
 * ① 窗口过期（或从未计数）→ 重置窗口起点、计数置 1，changes=1 即放行；
 * ② 窗口内 → `rate_count + 1 WHERE rate_count < limit`，changes=1 放行，
 *    changes=0 即第 N+1 条 → 超限。单语句原子性（D1 串行化）保证并发下
 *    第 N+1 条必被拦。
 *
 * 只统计通过验证门的消息：调用方（inbound 门 ③）保证仅已验证用户到达此处。
 */
export async function countMessageInWindow(
  db: D1Database,
  botId: number,
  userId: number,
  limit: number,
): Promise<boolean> {
  const reset = await db
    .prepare(
      `UPDATE users SET rate_window_start = ?, rate_count = 1
       WHERE bot_id = ? AND user_id = ?
         AND (rate_window_start IS NULL OR rate_window_start <= ?)`,
    )
    .bind(nowIso(), botId, userId, isoBefore(RATE_WINDOW_MS))
    .run();
  if (reset.meta.changes === 1) return true;

  const bump = await db
    .prepare(
      `UPDATE users SET rate_count = rate_count + 1
       WHERE bot_id = ? AND user_id = ? AND rate_count < ?`,
    )
    .bind(botId, userId, limit)
    .run();
  return bump.meta.changes === 1;
}

/* ==================================================================== */
/* 挑战栅栏与最终裁决（Turnstile 任务；三模式共用）                        */
/* ==================================================================== */

/** 出题预留的预期配置（出题时从 settings 快照取得；CAS 再校验防中途切换） */
export interface VerificationFenceExpectation {
  mode: VerifyMode;
  enabled: boolean;
  generation: number;
}

/** 挑战栅栏标识：请求摘要 + 配置版本（回填 / 清理 / 最终裁决共用的 CAS 键） */
export interface VerificationRequestFence {
  hash: string;
  generation: number;
}

/** settings 键在 SQL 条件中的「缺行回默认」表达式（与 settings store 解析一致） */
const MODE_SQL_DEFAULT = `COALESCE((SELECT value FROM settings WHERE key = 'verify_mode'), 'math')`;
const ENABLED_SQL_DEFAULT = `COALESCE((SELECT value FROM settings WHERE key = 'verify_enabled'), '1')`;

/**
 * 条件预留挑战（出题第一步，先于任何 Telegram 调用）：写入随机请求摘要 /
 * 到期时间 / 配置版本快照，并清空旧挑战字段（重发 = 以新请求原子替换旧请求）。
 *
 * WHERE 条件即裁决（单语句原子，无读-判-写竞态）：bot/user 归属、未封禁、
 * 未验证、以及**当前实际配置**（SQL 子查询，缺行回默认）仍等于出题时的
 * 快照——快照读取与预留之间若发生 /verifymode 切换或开关翻转，预留失败
 * （0 行变更），绝不让旧配置时代的挑战落库。调用方以 false 分支放弃本轮
 * 出题（重推后重新走完整流程）。
 *
 * expiresAt 传 null = math / button 题目不新增超时语义（列保持 NULL）；
 * Turnstile 传创建 + 600 秒。同时清 verify_submit_not_before（新请求不继承
 * 旧请求的提交节流窗口）。
 */
export async function reserveVerificationRequest(
  db: D1Database,
  botId: number,
  userId: number,
  expected: VerificationFenceExpectation,
  request: { hash: string; expiresAt: string | null },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET
         verify_request_hash = ?,
         verify_request_expires_at = ?,
         verify_request_generation = ?,
         verify_submit_not_before = NULL,
         verify_answer = NULL,
         verify_msg_id = NULL
       WHERE bot_id = ? AND user_id = ?
         AND is_banned = 0 AND is_verified = 0
         AND ${MODE_SQL_DEFAULT} = ?
         AND ${ENABLED_SQL_DEFAULT} = ?
         AND CAST(COALESCE((SELECT value FROM settings WHERE key = 'verify_generation'), '0') AS INTEGER) = ?`,
    )
    .bind(
      request.hash,
      request.expiresAt,
      expected.generation,
      botId,
      userId,
      expected.mode,
      expected.enabled ? "1" : "0",
      expected.generation,
    )
    .run();
  return result.meta.changes === 1;
}

/**
 * CAS 回填题面消息 ID（Telegram 送达成功后）：仅当当前请求仍是本轮回出的
 * 同一挑战（hash + generation 匹配）才写入 msgId 与答案——预留与回填之间
 * 挑战被作废 / 替换（模式切换、并发重发）时回填失败（0 行），旧消息的
 * callback 天然落「已失效」分支。answer 传 null = Turnstile 网页请求
 * （无整数答案概念，不写 verify_answer）。
 */
export async function attachVerifyMessage(
  db: D1Database,
  botId: number,
  userId: number,
  fence: VerificationRequestFence,
  params: { msgId: number; answer: number | null },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET verify_msg_id = ?, verify_answer = ?
       WHERE bot_id = ? AND user_id = ?
         AND verify_request_hash = ? AND verify_request_generation = ?
         AND is_verified = 0`,
    )
    .bind(params.msgId, params.answer, botId, userId, fence.hash, fence.generation)
    .run();
  return result.meta.changes === 1;
}

/**
 * 失败清理（发送 permanent 失败等）：仅当当前请求仍是本轮这个挑战时清空
 * 栅栏四列——绝不误删并发期间用户新拿到的挑战，也不触碰验证态。
 */
export async function clearVerificationRequest(
  db: D1Database,
  botId: number,
  userId: number,
  fence: VerificationRequestFence,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET
         verify_request_hash = NULL, verify_request_expires_at = NULL,
         verify_request_generation = NULL, verify_submit_not_before = NULL
       WHERE bot_id = ? AND user_id = ?
         AND verify_request_hash = ? AND verify_request_generation = ?
         AND is_verified = 0`,
    )
    .bind(botId, userId, fence.hash, fence.generation)
    .run();
  return result.meta.changes === 1;
}

/** Turnstile 提交节流窗口长度：每请求每 15 秒至多一次上游调用 */
export const VERIFY_SUBMIT_THROTTLE_MS = 15_000;

/**
 * 原子认领提交窗口（网页完成链，Siteverify 之前）：完全复刻 claimNoticeSlot
 * 的单语句原子模式——`verify_submit_not_before IS NULL 或已到期` 才允许置为
 * now + 15s；meta.changes === 1 即赢得本次提交许可。跨 isolate 生效（状态在
 * D1），并发 / 双击 / 重放在同一请求上至多一人通过。
 *
 * 认领必须仍匹配当前挑战（hash + generation）：旧挑战窗口已耗不拦新挑战，
 * 新请求认领成功也不提前结束旧失败留下的冷却（失败后冷却不立即清空——
 * 新请求 / 撤销 / 成功 / 封禁 / 配置变化各自清理）。
 */
export async function claimVerifySubmit(
  db: D1Database,
  botId: number,
  userId: number,
  fence: VerificationRequestFence,
  params: { now: string; nextNotBefore: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET verify_submit_not_before = ?
       WHERE bot_id = ? AND user_id = ?
         AND verify_request_hash = ? AND verify_request_generation = ?
         AND is_banned = 0 AND is_verified = 0
         AND (verify_submit_not_before IS NULL OR verify_submit_not_before <= ?)`,
    )
    .bind(params.nextNotBefore, botId, userId, fence.hash, fence.generation, params.now)
    .run();
  return result.meta.changes === 1;
}

/**
 * 网页验证的最终裁决（单条条件 UPDATE；await Siteverify 之后执行）：
 * meta.changes === 1 才是「本请求在当前配置下刚刚完成验证」的唯一事实——
 * 同时校验请求摘要 / 配置版本 / 未过期 / 本次认领标识 / 未封禁 / 未验证 /
 * 当前模式 = turnstile 且验证开启（SQL 子查询取最新实际值）。任一条件在
 * Siteverify 等待期间变化（过期、被替换、被封禁、被并发完成、模式切走）
 * 都让裁决失败（0 行），调用方不得宣告通过、不得延长 verified_at。
 * 成功分支同时清空全部 pending 与节流字段（一次性消费）。
 */
export async function completeTurnstileVerification(
  db: D1Database,
  botId: number,
  userId: number,
  fence: VerificationRequestFence,
  params: { now: string; submitNotBefore: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET
         is_verified = 1, verified_at = ?,
         verify_answer = NULL, verify_msg_id = NULL,
         verify_request_hash = NULL, verify_request_expires_at = NULL,
         verify_request_generation = NULL, verify_submit_not_before = NULL
       WHERE bot_id = ? AND user_id = ?
         AND verify_request_hash = ?
         AND verify_request_generation = ?
         AND verify_request_expires_at IS NOT NULL AND verify_request_expires_at > ?
         AND verify_submit_not_before = ?
         AND is_banned = 0 AND is_verified = 0
         AND ${MODE_SQL_DEFAULT} = 'turnstile'
         AND ${ENABLED_SQL_DEFAULT} = '1'`,
    )
    .bind(params.now, botId, userId, fence.hash, fence.generation, params.now, params.submitNotBefore)
    .run();
  return result.meta.changes === 1;
}

/**
 * Telegram 回调的最终裁决（单条条件 UPDATE；取代旧「读-判-写」的
 * markVerified 判卷路径）：正确答案之外还必须匹配当前挑战栅栏（hash /
 * msgId / answer / generation）、未封禁、未验证、以及回调预检时的配置
 * （mode / enabled，缺行回默认）——预检与裁决之间发生的一切变化（换题、
 * 模式切换、封禁、并发先答）都让裁决失败（0 行），调用方据此走「已失效」
 * 分支，绝不重复执行成功副作用。成功分支同时清空全部 pending 字段。
 */
export async function completeCallbackVerification(
  db: D1Database,
  botId: number,
  userId: number,
  fence: VerificationRequestFence & { mode: VerifyMode; enabled: boolean },
  params: { msgId: number; answer: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET
         is_verified = 1, verified_at = ?,
         verify_answer = NULL, verify_msg_id = NULL,
         verify_request_hash = NULL, verify_request_expires_at = NULL,
         verify_request_generation = NULL, verify_submit_not_before = NULL
       WHERE bot_id = ? AND user_id = ?
         AND verify_msg_id = ? AND verify_answer = ?
         AND verify_request_hash = ? AND verify_request_generation = ?
         AND is_banned = 0 AND is_verified = 0
         AND ${MODE_SQL_DEFAULT} = ?
         AND ${ENABLED_SQL_DEFAULT} = ?`,
    )
    .bind(
      nowIso(),
      botId,
      userId,
      params.msgId,
      params.answer,
      fence.hash,
      fence.generation,
      fence.mode,
      fence.enabled ? "1" : "0",
    )
    .run();
  return result.meta.changes === 1;
}

/** 网页完成链预检用的请求状态（行不存在 → null = 不得 ensureUser 重建） */
export interface VerifyRequestState {
  isBanned: boolean;
  isVerified: boolean;
  /** 当前请求摘要（SHA-256 十六进制；无有效挑战 → null） */
  verifyRequestHash: string | null;
  /** 请求到期时间（仅 Turnstile 写入；math/button 保持 NULL） */
  verifyRequestExpiresAt: string | null;
  /** 挑战的配置版本快照 */
  verifyRequestGeneration: number | null;
  /** 提交节流窗口的下一许可时间（未来 = 窗口占用中） */
  verifySubmitNotBefore: string | null;
  /** 题面 / 入口消息 ID（成功通知编辑该消息；网页请求也有对应 Telegram 消息） */
  verifyMsgId: number | null;
  /** 展示列（成功通知组装置顶信息用） */
  firstName: string;
  lastName: string;
  username: string;
}

/**
 * 只读请求状态（网页完成链预检；无副作用）：行不存在 → null。
 * 调用方绝不能据此 ensureUser / UPSERT 重建被删除的用户。
 */
export async function getVerifyRequestState(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<VerifyRequestState | null> {
  const row = await db
    .prepare(
      `SELECT is_banned, is_verified,
         verify_request_hash, verify_request_expires_at,
         verify_request_generation, verify_submit_not_before, verify_msg_id,
         first_name, last_name, username
       FROM users WHERE bot_id = ? AND user_id = ?`,
    )
    .bind(botId, userId)
    .first<{
      is_banned: number;
      is_verified: number;
      verify_request_hash: string | null;
      verify_request_expires_at: string | null;
      verify_request_generation: number | null;
      verify_submit_not_before: string | null;
      verify_msg_id: number | null;
      first_name: string;
      last_name: string;
      username: string;
    }>();
  if (!row) return null;
  return {
    isBanned: row.is_banned === 1,
    isVerified: row.is_verified === 1,
    verifyRequestHash: row.verify_request_hash,
    verifyRequestExpiresAt: row.verify_request_expires_at,
    verifyRequestGeneration: row.verify_request_generation,
    verifySubmitNotBefore: row.verify_submit_not_before,
    verifyMsgId: row.verify_msg_id,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
  };
}

/**
 * 按请求摘要反查持有者（网页完成链「用户不符」判定）：该 hash 属于另一个
 * 用户 → 返回其 user_id（调用方据此 403，绝不消费正确用户的请求）；
 * 无任何行持有该 hash → null（调用方按「旧请求 / 已失效」处理）。
 */
export async function findUserIdByRequestHash(
  db: D1Database,
  botId: number,
  hash: string,
): Promise<number | null> {
  const row = await db
    .prepare("SELECT user_id FROM users WHERE bot_id = ? AND verify_request_hash = ?")
    .bind(botId, hash)
    .first<{ user_id: number }>();
  return row?.user_id ?? null;
}
