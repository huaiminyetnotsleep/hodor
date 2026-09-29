-- hodor · D1 Console 现成查询集（面板 → Storage & Databases → D1 → hodor → Console，整段或单条粘贴执行）
-- 全部只读。消息正文属敏感数据：结果不外发、不贴公开日志（docs/09）。
-- 表结构详见 migrations/0001_init.sql。

-- █ 表清单
SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','d1_migrations') ORDER BY name;

-- █ 客户（最近 50）
SELECT id, telegram_user_id, display_name, username, blocked, watchlisted, bot_blocked_by_user, created_at, updated_at FROM customers ORDER BY id DESC LIMIT 50;

-- █ Bot 绑定行（webhook 状态排查：hash/连接信息不展示，只看存在性与时间）
SELECT id, telegram_bot_id, webhook_key, support_chat_id, created_at, updated_at FROM bots;

-- █ 管理员白名单
SELECT id, bot_id, telegram_user_id, added_via, created_at FROM support_admins ORDER BY bot_id, telegram_user_id;

-- █ 会话与 Topic 映射（最近 50）
SELECT id, bot_id, customer_id, message_thread_id, status, canonical_title, last_message_at FROM conversations ORDER BY last_message_at DESC LIMIT 50;

-- █ 消息（最近 50，正文截前 80 字）
SELECT id, conversation_id, direction, content_type, substr(text_content, 1, 80) AS text_head, created_at FROM messages ORDER BY id DESC LIMIT 50;

-- █ Inbox 状态机总览（按状态计数）
SELECT status, COUNT(*) AS n, MIN(received_at) AS earliest, MAX(received_at) AS latest FROM inbox_updates GROUP BY status ORDER BY n DESC;

-- █ Inbox 失败队列（重试闭环巡检，docs/03）
SELECT id, bot_id, telegram_update_id, attempts, last_error, received_at, processed_at FROM inbox_updates WHERE status = 'failed' ORDER BY id DESC LIMIT 50;

-- █ 审计日志（最近 50）
SELECT id, bot_id, actor_user_id, action, created_at FROM audit_logs ORDER BY id DESC LIMIT 50;

-- █ 已删除用户
SELECT * FROM deleted_users ORDER BY id DESC LIMIT 50;

-- █ 会话活跃度（消息数 Top 20）
SELECT c.id, c.canonical_title, c.status, COUNT(m.id) AS msg_count, c.last_message_at
FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
GROUP BY c.id ORDER BY msg_count DESC LIMIT 20;
