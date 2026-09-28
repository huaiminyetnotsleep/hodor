-- 0001 · 初始 Schema（docs/06-data-model.md 逐字段）
-- 全局约定：时间戳 ISO 8601 UTC TEXT；Telegram ID INTEGER；JSON 存 TEXT；布尔 0/1；主键自增。
-- outbox 属 Phase 2，本迁移不建（docs/06/08，Expand/Contract 加入）。后续迁移 append-only，不改本文件。

CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_bot_id INTEGER NOT NULL UNIQUE,              -- getMe().result.id
  webhook_key TEXT NOT NULL UNIQUE,                     -- webhook URL 路径标识（随机，仅混淆不鉴权，docs/05）
  encrypted_bot_token TEXT,                             -- Phase 1 恒为 NULL（Token 在 env，docs/05）
  webhook_secret_hash TEXT NOT NULL,                    -- SHA-256(TELEGRAM_WEBHOOK_SECRET)，鉴权比对用
  support_chat_id INTEGER NOT NULL,                     -- 私有支持群
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  config_version INTEGER NOT NULL DEFAULT 1,            -- 配置代数，绑定/解绑递增
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,                 -- Topic 标题中的 #序号
  bot_id INTEGER NOT NULL REFERENCES bots (id),
  telegram_user_id INTEGER NOT NULL,
  display_name TEXT,
  username TEXT,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),                            -- 封禁唯一事实源（docs/04）
  bot_blocked_by_user INTEGER NOT NULL DEFAULT 0 CHECK (bot_blocked_by_user IN (0, 1)),    -- 用户拉黑 Bot 标志（docs/03）
  watchlisted INTEGER NOT NULL DEFAULT 0 CHECK (watchlisted IN (0, 1)),                    -- 高危名单唯一事实源（docs/04）
  last_watch_notice_at TEXT,                            -- 最近高危入站提示时间，24h 限频（docs/03/04）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS deleted_users (              -- 删除用户墓碑（docs/04 /deluser），不含任何内容数据
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL REFERENCES bots (id),
  telegram_user_id INTEGER NOT NULL,
  was_watchlisted INTEGER NOT NULL DEFAULT 0 CHECK (was_watchlisted IN (0, 1)), -- /start 重建时继承
  deleted_at TEXT NOT NULL,
  deleted_by INTEGER,                                   -- 执行删除的管理员 user_id
  UNIQUE (bot_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS conversations (              -- 每用户至多一个 open（docs/02）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL REFERENCES bots (id),
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  support_chat_id INTEGER NOT NULL,                     -- 冗余存储，便于反向查询
  message_thread_id INTEGER,                            -- Topic ID；creating 期间为 NULL
  status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'closed', 'archived')), -- 生命周期，不含 blocked（docs/04）
  canonical_title TEXT,                                 -- 当前渲染标题（docs/02）
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, support_chat_id, message_thread_id)   -- 反向映射：管理员回复路由（SQLite 中 NULL 互不相等，creating 期不冲突）
);

CREATE TABLE IF NOT EXISTS support_admins (             -- 管理员白名单
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL REFERENCES bots (id),
  telegram_user_id INTEGER NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (bot_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS inbox_updates (              -- 幂等核心（docs/03）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL REFERENCES bots (id),
  telegram_update_id INTEGER NOT NULL,                  -- update_id 按 Bot 独立递增；换绑必须先归档本表（docs/05 Runbook）
  payload_json TEXT NOT NULL,                           -- 原始 Update；Phase 3 起大对象可外移 R2（docs/06）
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,                  -- 上限 MAX_ATTEMPTS（env，建议 8）
  received_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT,                                      -- 最近失败原因，不含敏感值
  UNIQUE (bot_id, telegram_update_id)
);

CREATE TABLE IF NOT EXISTS messages (                   -- 中继记录（docs/03/07）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  source_chat_id INTEGER,                               -- 复制源
  source_message_id INTEGER,
  target_chat_id INTEGER,                               -- 复制目标
  target_message_id INTEGER,
  message_thread_id INTEGER,                            -- 冗余 Topic ID
  content_type TEXT NOT NULL DEFAULT 'text',            -- text / photo / voice / document / …
  text_content TEXT,                                    -- 文本或 caption，检索用
  media_file_id TEXT,                                   -- Telegram file_id：媒体主存引用，可重发（docs/07）
  r2_object_key TEXT,                                   -- Phase 3 附件归档键
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (                 -- 操作审计（docs/04/05/09）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL REFERENCES bots (id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'system')),
  actor_id INTEGER,                                     -- admin 的 telegram_user_id；system 为 NULL
  action TEXT NOT NULL,                                 -- ban / unban / purge / risk / unrisk / deluser /
                                                        -- webhook_bind / webhook_unbind / admin_add / admin_remove /
                                                        -- topic_creation_retry / unknown_user_rejected …
  detail_json TEXT,                                     -- 不含 Token / Secret / 消息正文
  created_at TEXT NOT NULL
);

-- 次要索引（docs/06 索引清单；唯一索引为建表约束）
CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations (bot_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status   ON conversations (bot_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_conversation  ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_status           ON inbox_updates (status, attempts); -- DLQ 巡检
CREATE INDEX IF NOT EXISTS idx_audit_bot_time         ON audit_logs (bot_id, created_at);
