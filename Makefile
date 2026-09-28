# 只读运维查询（docs/09「运维方式」：仅固化只读查询，管理端操作不封装，直接调 /admin 端点）
# 用法：make db-customers            # 本地
#       make db-customers REMOTE=1   # 远端

DB_NAME := hodor
REMOTE ?=
D1_FLAGS := $(if $(REMOTE),--remote,)

.PHONY: db-customers db-conversations db-messages db-inbox-failed

db-customers:
	npx wrangler d1 execute $(DB_NAME) --command "SELECT id, telegram_user_id, display_name, username, blocked, watchlisted, bot_blocked_by_user, created_at, updated_at FROM customers ORDER BY id DESC LIMIT 50" $(D1_FLAGS)

db-conversations:
	npx wrangler d1 execute $(DB_NAME) --command "SELECT id, bot_id, customer_id, message_thread_id, status, canonical_title, last_message_at FROM conversations ORDER BY last_message_at DESC LIMIT 50" $(D1_FLAGS)

db-messages:
	npx wrangler d1 execute $(DB_NAME) --command "SELECT id, conversation_id, direction, content_type, substr(text_content, 1, 80) AS text_head, created_at FROM messages ORDER BY id DESC LIMIT 50" $(D1_FLAGS)

db-inbox-failed:
	npx wrangler d1 execute $(DB_NAME) --command "SELECT id, bot_id, telegram_update_id, attempts, last_error, received_at, processed_at FROM inbox_updates WHERE status = 'failed' ORDER BY id DESC LIMIT 50" $(D1_FLAGS)
