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
