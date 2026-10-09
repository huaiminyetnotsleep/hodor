-- 全用户广播（2026-10-09 任务 10-09-user-broadcast）：一份广播一行
-- 字段与语义唯一事实源：docs/guide/database.md
-- 全局约定：所有表带 bot_id 维度；时间戳 ISO-8601 UTC 文本；布尔用 0/1 整数；不建外键
-- 幂等由 wrangler migrations 台账保证：不写 IF NOT EXISTS，不写任何 DROP / 破坏性语句
-- 行只存活于任务期间：终态（completed/cancelled/expired/failed）行在控制消息收尾后删除
CREATE TABLE broadcasts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id             INTEGER NOT NULL,
  source_update_id   INTEGER NOT NULL,
  initiator_user_id  INTEGER NOT NULL,
  support_chat_id    INTEGER NOT NULL,
  preview_msg_id     INTEGER,
  control_msg_id     INTEGER,
  message_html       TEXT NOT NULL,
  recipient_ids_json TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'preparing'
                     CHECK (status IN ('preparing','pending','sending','completed','cancelled','expired','failed')),
  expected_count     INTEGER NOT NULL DEFAULT 0 CHECK (expected_count >= 0),
  success_count      INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count      INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  expires_at         TEXT NOT NULL,
  confirmed_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 同一发起 update 重推不新建第二份广播（webhook at-least-once 幂等复用）
CREATE UNIQUE INDEX idx_broadcasts_source ON broadcasts(bot_id, source_update_id);

-- 每 Bot 同时最多一份发送中的广播（原子确认 pending → sending 时裁决并发）
CREATE UNIQUE INDEX idx_broadcasts_active_sending ON broadcasts(bot_id) WHERE status = 'sending';

-- 每 Bot 同时最多一份草稿/待确认（preparing 与 pending 各算占用；可与发送中任务并存）
CREATE UNIQUE INDEX idx_broadcasts_active_draft ON broadcasts(bot_id) WHERE status IN ('preparing','pending');
