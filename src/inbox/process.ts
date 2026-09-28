/**
 * inbox · 幂等状态机（S3，docs/03 核心 + docs/08 重试闭环）。
 *
 * 推进规则（docs/03 状态图逐条落地）：
 * - 登记行 processed / failed → 直接 200 跳过（终结态不重执行；failed = 手工 DLQ）；
 * - pending 且 attempts < MAX_ATTEMPTS → 执行处理器；
 * - 处理器成功 → processed + processed_at → 200；
 * - 处理器抛错 → attempts + 1：未达上限保持 pending → 5xx（Telegram 重投）；
 *   达到上限 → failed → 200（停止无限重投，docs/08）；
 * - handler === null（'ignore' 分类）→ 不进业务管线，标记 processed → 200；
 * - blocked 拒绝 / 400 毒丸由处理器标记 processed 后正常返回（docs/03 错误分类），
 *   状态机不区分错误类型——抛错即重试、正常返回即成功。
 *
 * 硬规则：所有写入 await 完成后才返回响应；禁止 waitUntil（docs/08 关键持久化规则）。
 */
import type { UpdateContext, UpdateHandler } from '../domain';
import type { InboxStatus, RegisterUpdateResult } from './register';

/** MAX_ATTEMPTS 建议值 8（docs/03；env 缺失/非法时回退，src/env.d.ts 消费约定） */
export const DEFAULT_MAX_ATTEMPTS = 8;

export interface ProcessResult {
  /** 应返回给 Telegram 的 HTTP 状态码：200 或 500（5xx 触发重投） */
  httpStatus: 200 | 500;
  /** true = 处理器本轮未执行（终结态跳过 / 超限熔断 / 忽略分类） */
  skipped: boolean;
  /** 本轮结束时该 Update 的行状态 */
  rowStatus: InboxStatus;
}

/**
 * 解析 env.MAX_ATTEMPTS：正整数才生效，缺失/非正整数/非法一律回退 8
 * （「parse, don't trust」，.trellis/spec/backend/env-config.md）。
 */
export function resolveMaxAttempts(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return parsed;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** pending → processed；带 status='pending' 守卫，处理器已自行标记时为无害 no-op */
async function markProcessed(db: D1Database, botId: number, updateId: number): Promise<void> {
  await db
    .prepare(
      "UPDATE inbox_updates SET status = 'processed', processed_at = ? WHERE bot_id = ? AND telegram_update_id = ? AND status = 'pending'",
    )
    .bind(nowIso(), botId, updateId)
    .run();
}

/** pending → failed（不记消息正文；last_error 只存失败原因摘要，docs/06） */
async function markFailed(
  db: D1Database,
  botId: number,
  updateId: number,
  lastError: string,
  incrementAttempts: boolean,
): Promise<void> {
  const sql = incrementAttempts
    ? "UPDATE inbox_updates SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE bot_id = ? AND telegram_update_id = ? AND status = 'pending'"
    : "UPDATE inbox_updates SET status = 'failed', last_error = ? WHERE bot_id = ? AND telegram_update_id = ? AND status = 'pending'";
  await db.prepare(sql).bind(lastError, botId, updateId).run();
}

/** 失败但未超限：attempts + 1、保持 pending（等待 Telegram 重投） */
async function recordFailure(db: D1Database, botId: number, updateId: number, lastError: string): Promise<void> {
  await db
    .prepare(
      "UPDATE inbox_updates SET attempts = attempts + 1, last_error = ? WHERE bot_id = ? AND telegram_update_id = ? AND status = 'pending'",
    )
    .bind(lastError, botId, updateId)
    .run();
}

/**
 * 按登记结果推进状态机（docs/03 状态图）。
 *
 * @param ctx 处理器上下文（update 取自本次请求体；重放负载与登记行一致）
 * @param registration registerUpdate 的返回（new 或 duplicate 行）
 * @param handler 分类对应的处理器；null = 'ignore' 分类，不进业务管线
 * @param maxAttempts 已解析的尝试上限（resolveMaxAttempts）
 */
export async function processUpdate(
  ctx: UpdateContext,
  registration: RegisterUpdateResult,
  handler: UpdateHandler | null,
  maxAttempts: number,
): Promise<ProcessResult> {
  const { db, bot, update } = ctx;

  if (registration.status === 'duplicate') {
    const row = registration.row;
    // 终结态：已处理/已失败 → 200 跳过（「登记过」≠「处理过」，但终结态不再执行）
    if (row.status !== 'pending') {
      return { httpStatus: 200, skipped: true, rowStatus: row.status };
    }
    // 超限熔断：pending 且 attempts ≥ MAX_ATTEMPTS → failed + 200（手工 DLQ，docs/08）
    if (row.attempts >= maxAttempts) {
      await markFailed(db, bot.id, update.update_id, 'max attempts exceeded', false);
      return { httpStatus: 200, skipped: true, rowStatus: 'failed' };
    }
    // pending 且未超限 → 作为重试重新执行（落到下方执行段）
  }

  // 忽略分类：不触碰任何处理器，标记 processed（docs/03 忽略策略：静默 + processed）
  if (handler === null) {
    await markProcessed(db, bot.id, update.update_id);
    return { httpStatus: 200, skipped: true, rowStatus: 'processed' };
  }

  const attemptsBeforeRun = registration.status === 'new' ? 0 : registration.row.attempts;
  try {
    await handler(ctx);
    await markProcessed(db, bot.id, update.update_id);
    return { httpStatus: 200, skipped: false, rowStatus: 'processed' };
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error);
    const attempts = attemptsBeforeRun + 1;
    if (attempts >= maxAttempts) {
      // 达上限：failed + 200，停止 Telegram 无限重投（docs/03/08）
      await markFailed(db, bot.id, update.update_id, lastError, true);
      return { httpStatus: 200, skipped: false, rowStatus: 'failed' };
    }
    await recordFailure(db, bot.id, update.update_id, lastError);
    return { httpStatus: 500, skipped: false, rowStatus: 'pending' };
  }
}
