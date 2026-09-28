# 手工引导 Runbook（S4 · dev-only）

> 目标：不依赖 S9 的 `/admin/setup`，手工完成「seed bots 行 → 绑定 webhook」，让第一条真实用户消息端到端落进自动创建的 Topic（0→1 里程碑验收）。
> 适用环境：本地 `wrangler dev`（配合隧道）或 workers.dev 部署。**只对测试 Bot 操作**（docs/10：绝不使用生产 Bot）。

## 0. 前提清单

- 测试 Bot（BotFather 创建，记下 `TELEGRAM_BOT_TOKEN`）；
- 测试私有 Forum 群（Supergroup 开启 Topics，Bot 为管理员，需 Manage Topics + Send Messages 权限；**不开**「限制保存内容」，docs/02 红线）；
- 用户 A / 用户 B 两个测试账号 + 一个测试管理员账号；
- 群 `chat_id`（-100 开头；取法见 docs/05 前置清单：把 Bot 拉进群后用 getUpdates 看第一条消息的 `chat.id`）；
- `wrangler login` 已完成。

## 1. 配置 `.dev.vars`

```bash
cp .dev.vars.example .dev.vars
```

填入真值（7 条，注释见模板；`.dev.vars` 已被 git 忽略，绝不提交）：

```text
TELEGRAM_BOT_TOKEN=123456:AA...        # BotFather 给的 Token
TELEGRAM_WEBHOOK_SECRET=...            # 自拟随机串；第 2/3 步要用它的「原文」
ADMIN_SETUP_SECRET=...                 # S9 才消费，先随便填
SUPPORT_CHAT_ID=-100xxxxxxxxxx         # 测试 Forum 群 chat_id
ADMIN_IDS=<管理员 user_id>
ALLOW_UNKNOWN_USERS=true
MAX_ATTEMPTS=8
```

## 2. 计算 webhook_secret_hash

bots 行存的是 `SHA-256(TELEGRAM_WEBHOOK_SECRET)` 的十六进制小写（docs/05，Worker 侧用它常量时间比对 Secret 头）。**注意不要把原文带进任何提交文件**：

```bash
# macOS（shasum）；关键点：printf 不带换行，不要用 echo（会多一个 \n 改变哈希）
printf '%s' '你的TELEGRAM_WEBHOOK_SECRET原文' | shasum -a 256
# Linux
printf '%s' '你的TELEGRAM_WEBHOOK_SECRET原文' | sha256sum
# 或 Node（跨平台一致）
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" '你的SECRET原文'
```

记下 64 位 hex 输出，第 4 步用。

## 3. 取 telegram_bot_id 并应用迁移

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"
# → {"ok":true,"result":{"id":<TELEGRAM_BOT_ID>, ...}}，记下 result.id

npx wrangler d1 migrations apply hodor --local    # 本地库
# 远端部署路径再加：npx wrangler d1 migrations apply hodor --remote
```

## 4. 手工 seed bots 行（wrangler d1 execute）

SQL 模板（把尖括号占位替换为真值；`webhook_key` 自拟，示例 `k-test-bot`，它只是 URL 混淆不承担鉴权，docs/05）：

```sql
INSERT INTO bots
  (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, status, created_at, updated_at)
VALUES
  (<TELEGRAM_BOT_ID>, 'k-test-bot', '<第2步的sha256hex>', <SUPPORT_CHAT_ID>, 'active',
   strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))
ON CONFLICT (telegram_bot_id) DO NOTHING;
```

执行（本地与远端二选一或都做；`--command` 里 SQL 需单行化）：

```bash
# 本地
npx wrangler d1 execute hodor --local --command "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, status, created_at, updated_at) VALUES (<TELEGRAM_BOT_ID>, 'k-test-bot', '<sha256hex>', <SUPPORT_CHAT_ID>, 'active', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT (telegram_bot_id) DO NOTHING"

# 远端（workers.dev 路径用）
npx wrangler d1 execute hodor --remote --command "<同上>"
```

核验与重置：

```bash
npx wrangler d1 execute hodor --local --command "SELECT id, telegram_bot_id, webhook_key, support_chat_id, status FROM bots"
# 重复执行不生效（ON CONFLICT DO NOTHING）；换 Secret/换 key 用 UPDATE：
# UPDATE bots SET webhook_secret_hash = '<新hash>', webhook_key = 'k-test-bot' WHERE telegram_bot_id = <TELEGRAM_BOT_ID>;
```

## 5. 绑定 webhook（两条路径二选一）

### 路径 A：本地 wrangler dev + cloudflared 隧道

```bash
npx wrangler dev            # 默认 http://localhost:8787（自动加载 .dev.vars）
cloudflared tunnel --url http://localhost:8787
# 输出里找临时域名，形如 https://<random-words>.trycloudflare.com
```

setWebhook（JSON 体；`secret_token` 必须与 `.dev.vars` 的 `TELEGRAM_WEBHOOK_SECRET` 原文完全一致；`allowed_updates=["message"]` 是 docs/03 的显式决策）：

```bash
curl -sS -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://<random-words>.trycloudflare.com/telegram/webhook/k-test-bot",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET原文>",
    "allowed_updates": ["message"],
    "drop_pending_updates": true
  }'
# → {"ok":true,"result":true,"description":"Webhook was set"}
```

### 路径 B：部署到 workers.dev

```bash
npm run deploy    # = provision（解析/创建 D1 + 迁移）+ deploy
```

远端变量配置一次（`keep_vars: true` 保证跨部署持久，docs/spec env-config）：面板 → Worker → 设置 → 变量和机密，填同 `.dev.vars` 的 7 条；或 `npx wrangler secret put TELEGRAM_BOT_TOKEN` 等三条 Secret。然后：

```bash
curl -sS -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://hodor.<你的子域>.workers.dev/telegram/webhook/k-test-bot",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET原文>",
    "allowed_updates": ["message"],
    "drop_pending_updates": true
  }'
```

### 绑定核验 / 解绑

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
# url 非空、last_error_date/last_error_message 为空、pending_update_count 归零即健康
curl -sS "https://<worker域名>/health"            # 唯一 GET，返回版本与存活（docs/09）

# 解绑（不丢 pending updates，docs/05）：
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"
```

## 6. 真机回归 5 步清单（★0→1 里程碑，人工执行）

1. **首条文本**：用户 A 私聊 Bot 发文本 → 支持群自动创建 Topic，标题 = `👤 <昵称> <完整用户ID> · #<序号>`，消息出现在 Topic 内，A 收到 WELCOME。
2. **媒体**：A 发图片 → 同一 Topic 收到图；`make db-messages REMOTE=1`（本地去掉 REMOTE=1）能看到 `photo` 记录（media_file_id 用下面命令查）。
   ```bash
   npx wrangler d1 execute hodor --remote --command "SELECT id, conversation_id, direction, content_type, media_file_id, substr(text_content,1,40) FROM messages ORDER BY id DESC LIMIT 5"
   ```
3. **隔离**：用户 B 发消息 → 进入 B 自己的 Topic（标题带 B 的 ID 与 #序号），与 A 的 Topic 不串线。
4. **改名刷新**：A 改 Telegram 昵称后再发一条 → Topic 标题刷新为新昵称（全量重渲染）。
5. **重放幂等**：用相同 `update_id` 重放（curl 打 webhook，带 Secret 头）→ 返回 200，不重复建题、不重复发 WELCOME。
   ```bash
   curl -sS -X POST "https://<worker域名>/telegram/webhook/k-test-bot" \
     -H 'content-type: application/json' \
     -H "x-telegram-bot-api-secret-token: <TELEGRAM_WEBHOOK_SECRET原文>" \
     -d '{"update_id": 999001, "message": {"message_id": 999001, "from": {"id": <A的ID>, "is_bot": false, "first_name": "A"}, "chat": {"id": <A的ID>, "type": "private"}, "date": 1760000000, "text": "replay"}}'
   ```
   （注意：重放**新** `update_id` 会走正常链路，只有重放**已登记**的 `update_id` 才验证幂等；先真实发一条再用其 update_id 重放。）

巡检辅助：`make db-customers` / `make db-conversations` / `make db-messages` / `make db-inbox-failed`（`REMOTE=1` 查远端，docs/09 只读固化查询）。
