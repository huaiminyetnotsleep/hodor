/**
 * store · audit_logs 写入辅助（S3 交付函数与 action 命名约定，docs/06；
 * 业务接入在 S4/S6/S9）。detail 不含 Token / Secret / 消息正文（docs/06 硬约束）。
 */

export type AuditActorType = 'admin' | 'system';

/**
 * audit_logs.action 常量表 = docs/06 action 注释全集（含 docs/04 /deluser、
 * docs/02 topic_creation_retry、docs/09 unknown_user_rejected）。
 * 值即入库字符串；禁止调用方自造字面量（code-reuse：常量单点定义）。
 */
export const AUDIT_ACTIONS = {
  webhookBind: 'webhook_bind',
  webhookUnbind: 'webhook_unbind',
  ban: 'ban',
  unban: 'unban',
  purge: 'purge',
  risk: 'risk',
  unrisk: 'unrisk',
  deluser: 'deluser',
  adminAdd: 'admin_add',
  adminRemove: 'admin_remove',
  topicCreationRetry: 'topic_creation_retry',
  unknownUserRejected: 'unknown_user_rejected',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  botId: number;
  actorType: AuditActorType;
  /** admin 的 telegram_user_id；system 省略（docs/06：system 为 NULL） */
  actorId?: number;
  action: AuditAction;
  /** 上下文（customer_id、thread_id 等）；不含敏感值（docs/06） */
  detail?: Record<string, unknown>;
}

export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_logs (bot_id, actor_type, actor_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      entry.botId,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      new Date().toISOString(), // 全局约定：ISO 8601 UTC（migrations/0001 头注）
    )
    .run();
}

/** findLatestAction 命中行投影（S8 两步确认窗口判定消费：created_at 判窗口、actorId 供对账） */
export interface LatestActionRecord {
  createdAt: string;
  /** admin 的 telegram_user_id；system 行为 null（docs/06） */
  actorId: number | null;
}

/**
 * 最新一条 action 匹配且 detail.customer_id 等于给定客户的审计行（S8 /purge /deluser
 * 两步确认的 10 分钟窗口判定，docs/04「确认是无状态的」——不新增确认表，复用发起审计）。
 * SQL 端只按 bot+action 取最近若干条（管理命令量级极低，50 条余量充足），
 * customer_id 匹配在 JS 端解析 detail_json 精确判等——避免 LIKE 子串误命中
 * （如 `"customer_id":12` 命中 `"customer_id":123`）。查无返回 undefined。
 */
export async function findLatestAction(
  db: D1Database,
  botId: number,
  action: AuditAction,
  detailCustomerId: number,
): Promise<LatestActionRecord | undefined> {
  const res = await db
    .prepare('SELECT actor_id, detail_json, created_at FROM audit_logs WHERE bot_id = ? AND action = ? ORDER BY id DESC LIMIT 50')
    .bind(botId, action)
    .all<{ actor_id: number | null; detail_json: string | null; created_at: string }>();
  for (const row of res.results) {
    try {
      const detail = JSON.parse(row.detail_json ?? '{}') as { customer_id?: unknown };
      if (detail.customer_id === detailCustomerId) {
        return { createdAt: row.created_at, actorId: row.actor_id };
      }
    } catch {
      // detail_json 损坏的行跳过（防御，docs/03 判空原则）
    }
  }
  return undefined;
}
