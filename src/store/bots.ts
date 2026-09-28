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

/**
 * 按 telegram_bot_id 查 bots 行；查无返回 undefined。
 * 管理端点（S9 status/unbind/admins）以 env Token 的 getMe 结果定位事实源行
 * （docs/05：env 是引导通道，D1 才是事实源）。
 */
export async function findByTelegramBotId(db: D1Database, telegramBotId: number): Promise<Bot | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM bots WHERE telegram_bot_id = ?`)
    .bind(telegramBotId)
    .first<Bot>();
  return row ?? undefined;
}

export interface BotSetupInput {
  telegramBotId: number;
  /** SHA-256(TELEGRAM_WEBHOOK_SECRET) 十六进制小写（调用方算好传入） */
  webhookSecretHash: string;
  supportChatId: number;
}

/**
 * setup 的 seed/upsert 原语（S9，docs/05「初始化与绑定流程」步骤 ③）。
 *
 * - 首次插入：webhook_key 取随机 16 hex（UUID 去连字符截取，docs/05：仅混淆不鉴权），
 *   status='active'、config_version=1（migrations/0001 默认代数）；
 * - 冲突（重复 setup）：**只更新其余列，不改 webhook_key**——Webhook URL 长期稳定，
 *   发布/重绑都不换地址（docs/05），config_version 递增标记配置代数；
 * - 返回 upsert 后的完整行（webhook_key 新旧两种情况都从库里读回，单点事实）。
 */
export async function upsertBotForSetup(db: D1Database, input: BotSetupInput): Promise<Bot> {
  const now = new Date().toISOString();
  const webhookKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

  await db
    .prepare(
      `INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, status, config_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 1, ?, ?)
       ON CONFLICT (telegram_bot_id) DO UPDATE SET
         webhook_secret_hash = excluded.webhook_secret_hash,
         support_chat_id = excluded.support_chat_id,
         status = 'active',
         config_version = config_version + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(input.telegramBotId, webhookKey, input.webhookSecretHash, input.supportChatId, now, now)
    .run();

  const row = await findByTelegramBotId(db, input.telegramBotId);
  if (row === undefined) {
    throw new Error(`bots row missing after upsert: telegram_bot_id=${input.telegramBotId}`);
  }
  return row;
}
