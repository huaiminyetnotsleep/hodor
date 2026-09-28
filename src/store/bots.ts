/**
 * store · bots 表访问（S3，docs/06）。
 * 列清单唯一来源 = migrations/0001_init.sql；行结构在此声明一次，消费方经 `../store` 引用。
 */

export interface Bot {
  id: number;
  telegram_bot_id: number;
  webhook_key: string;
  /** Phase 1 恒为 NULL（Token 在 env，docs/05） */
  encrypted_bot_token: string | null;
  /** SHA-256(TELEGRAM_WEBHOOK_SECRET) 十六进制小写，webhook 鉴权比对用（docs/05） */
  webhook_secret_hash: string;
  support_chat_id: number;
  status: 'active' | 'disabled';
  config_version: number;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS =
  'id, telegram_bot_id, webhook_key, encrypted_bot_token, webhook_secret_hash, support_chat_id, status, config_version, created_at, updated_at';

/**
 * 按 webhook_key 查 bots 行；查无返回 undefined（路由层 → 404）。
 * webhook_key 仅 URL 混淆不承担鉴权，鉴权靠 Secret 头与 webhook_secret_hash 比对（docs/05）。
 */
export async function findByWebhookKey(db: D1Database, webhookKey: string): Promise<Bot | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM bots WHERE webhook_key = ?`)
    .bind(webhookKey)
    .first<Bot>();
  return row ?? undefined;
}
