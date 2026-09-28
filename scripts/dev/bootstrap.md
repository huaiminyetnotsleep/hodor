# 手工引导 Runbook（S4 · dev-only）

> 目标：不依赖 S9 的 `/admin/setup`，手工完成「seed bots 行 → 绑定 webhook」，让第一条真实用户消息端到端落进自动创建的 Topic（0→1 里程碑验收）。
> **只对测试 Bot 操作**（docs/10：绝不使用生产 Bot）。

## 快径：直接在 CF 上验证（推荐，浏览器即可完成）

> 前提：代码已 push 且 Workers Builds 部署成功；面板 Worker → 设置 → 变量和机密 已配好 7 个值（`keep_vars: true` 保证不丢）。

1. **建 D1 迁移**（若自动部署未含迁移）：面板 → Storage & Databases → `hodor` → Console，粘贴执行 `wrangler d1 migrations apply` 的等价建表脚本见 migrations/0001_init.sql（通常部署命令已执行，跳过）
2. **seed bots 行**：仍在 D1 Console 执行（占位替换为真值；`webhook_key` 自拟，示例 `k-test-bot`）：

   ```sql
   INSERT INTO bots
     (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, status, created_at, updated_at)
   VALUES
     (<TELEGRAM_BOT_ID>, 'k-test-bot', '<SHA256(TELEGRAM_WEBHOOK_SECRET)>', <SUPPORT_CHAT_ID>, 'active',
      strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))
   ON CONFLICT (telegram_bot_id) DO NOTHING;
   ```

   - `<TELEGRAM_BOT_ID>`：浏览器打开 `https://api.telegram.org/bot<TOKEN>/getMe` 取 `result.id`
   - `<SHA256(...)>`：64 位 hex 小写，**原文必须与面板 `TELEGRAM_WEBHOOK_SECRET` 完全一致**（计算命令见第 2 节；无本地终端可用任意 SHA-256 在线工具，注意输入不含换行）
   - `<SUPPORT_CHAT_ID>`：面板变量里的同一个值（-100 开头负数）
3. **绑定 webhook**（浏览器打开，替换占位）：

   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://hodor.<你的子域>.workers.dev/telegram/webhook/k-test-bot&secret_token=<TELEGRAM_WEBHOOK_SECRET原文>&allowed_updates=["message"]
   ```

   → 返回 `{"ok":true,"result":true,"description":"Webhook was set"}`
4. **验证**：`https://hodor.<你的子域>.workers.dev/health` → `{"ok":true,"version":"0.1.0"}`；然后做下方第 6 节的 5 步回归

## 前提清单

- 测试 Bot（BotFather 创建，记下 `TELEGRAM_BOT_TOKEN`）；
- 测试私有 Forum 群（Supergroup 开启 Topics，Bot 为管理员，需 Manage Topics + Send Messages；**不开**「限制保存内容」，docs/02 红线）；
- 用户 A / 用户 B 两个测试账号 + 一个测试管理员账号；
- 群 `chat_id`（-100 开头；getUpdates 取法见 docs/05 前置清单）。

## 第 2 节：计算 webhook_secret_hash（CLI）

bots 行存 `SHA-256(TELEGRAM_WEBHOOK_SECRET)` 的十六进制小写（Worker 侧常量时间比对）。**原文不要带进任何提交文件**：

```bash
# macOS；关键：printf 不带换行（echo 会多 \n 改变哈希）
printf '%s' '你的TELEGRAM_WEBHOOK_SECRET原文' | shasum -a 256
# Linux
printf '%s' '你的TELEGRAM_WEBHOOK_SECRET原文' | sha256sum
# Node（跨平台一致）
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" '你的SECRET原文'
```

## CLI 路径（可选，与快径等价）

本地开发调试才需要 `.dev.vars`：`cp .dev.vars.example .dev.vars` 填真值（git 忽略）。
迁移与 seed：

```bash
npx wrangler d1 migrations apply hodor --remote
npx wrangler d1 execute hodor --remote --command "INSERT INTO bots (telegram_bot_id, webhook_key, webhook_secret_hash, support_chat_id, status, created_at, updated_at) VALUES (<TELEGRAM_BOT_ID>, 'k-test-bot', '<sha256hex>', <SUPPORT_CHAT_ID>, 'active', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT (telegram_bot_id) DO NOTHING"
npx wrangler d1 execute hodor --remote --command "SELECT id, telegram_bot_id, webhook_key, support_chat_id, status FROM bots"
```

换 Secret/换 key 用 UPDATE：`UPDATE bots SET webhook_secret_hash='<新hash>' WHERE telegram_bot_id=<ID>;`

本地 `wrangler dev` + cloudflared 隧道路径：

```bash
npx wrangler dev            # http://localhost:8787（自动加载 .dev.vars）
cloudflared tunnel --url http://localhost:8787   # 取临时 trycloudflare.com 域名
```

setWebhook（JSON 体版，`secret_token` 必须与 hash 同源原文；`allowed_updates=["message"]` 是 docs/03 显式决策）：

```bash
curl -sS -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://<worker域名>/telegram/webhook/k-test-bot","secret_token":"<原文>","allowed_updates":["message"],"drop_pending_updates":true}'
```

绑定核验 / 解绑：

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
# url 非空、last_error_date/last_error_message 为空、pending_update_count 归零即健康
curl -sS "https://<worker域名>/health"            # 唯一 GET（docs/09）
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"   # 解绑（保留 pending）
```

## 真机回归 5 步清单（★0→1 里程碑，人工执行）

1. **首条文本**：用户 A 私聊 Bot 发文本 → 支持群自动创建 Topic，标题 = `👤 <昵称> <完整用户ID> · #<序号>`，消息出现在 Topic 内，A 收到 WELCOME。
2. **媒体**：A 发图片 → 同一 Topic 收到图；查落库：
   ```bash
   npx wrangler d1 execute hodor --remote --command "SELECT id, conversation_id, direction, content_type, media_file_id, substr(text_content,1,40) FROM messages ORDER BY id DESC LIMIT 5"
   ```
   （纯面板路径：D1 Console 里执行同 SQL。）
3. **隔离**：用户 B 发消息 → 进入 B 自己的 Topic（B 的 ID 与 #序号），与 A 不串线。
4. **改名刷新**：A 改 Telegram 昵称后再发一条 → Topic 标题刷新为新昵称。
5. **重放幂等**：先真实发一条，再从 getUpdates/上一响应取其 `update_id`，curl 重放：
   ```bash
   curl -sS -X POST "https://<worker域名>/telegram/webhook/k-test-bot" \
     -H 'content-type: application/json' \
     -H "x-telegram-bot-api-secret-token: <原文>" \
     -d '{"update_id": <已登记的ID>, "message": {"message_id": <同ID>, "from": {"id": <A的ID>, "is_bot": false, "first_name": "A"}, "chat": {"id": <A的ID>, "type": "private"}, "date": 1760000000, "text": "replay"}}'
   ```
   → 200，不重复建题、不重复发 WELCOME。（重放**新** update_id 走正常链路，不验证幂等。）

巡检辅助：`make db-customers / db-conversations / db-messages / db-inbox-failed`（`REMOTE=1` 查远端）或 D1 Console。

## 附录：换绑归档台账（S9 · docs/05 换绑 Runbook 步骤 ③）

> 适用时机：**跨 Bot 换绑**（docs/05「换绑机器人」）时执行一次；常规部署/重绑**不需要**。
> 前提：已 `POST /admin/webhook/unbind`（此后 Worker 无入站流量，是唯一安全窗口），且
> `inbox_updates` 无 pending 积压——pending 不为 0 时**禁止继续**，先排干（docs/08）。

```sql
-- ① 核对：pending 必须为 0（不为 0 说明还有积压在投递，先等它排干）
SELECT COUNT(*) FROM inbox_updates WHERE status = 'pending';

-- ② 先导出备份（Phase 3 起落 R2），再清空已终结行（幂等：重复执行无副作用）
DELETE FROM inbox_updates WHERE status IN ('processed','failed');
```

执行通道：D1 Console 或 `npx wrangler d1 execute hodor --remote --command "<SQL>"`；
直查库不经过 `audit_logs`（docs/09 运维边界），操作者自律：只在换绑窗口执行、不外发数据。

**为什么必须做**：`update_id` 序列每个 Bot 独立递增。老 Bot 已把 1..N 写进 `inbox_updates`，
新 Bot 的 Update 几乎必然从低位重新开始——不清台账，新消息会与旧行命中
`UNIQUE(bot_id, telegram_update_id)`，旧行状态是 processed → 新消息被幂等机制**静默吞掉**
（docs/05「为什么必须归档台账」）。换绑收尾见 docs/05 Runbook ④–⑦。

## 排错表

| 现象 | 原因与解法 |
|---|---|
| Telegram 侧回调 401 | `secret_token` 与 bots 行 `webhook_secret_hash` 不同源——重算 hash（注意无换行）并 UPDATE bots 行，或重设 setWebhook |
| 404 | URL 路径的 `webhook_key` 与 seed 行不一致（示例 `k-test-bot`） |
| 消息进了 General Topic | 说明代码未带 thread——本版本已修复（copyMessage 带 message_thread_id）；确认部署包含 9e13d1f 之后代码 |
| 无 Topic 创建、无 WELCOME | 查 ①面板 `ALLOW_UNKNOWN_USERS` 是否 "false"；②该用户是否在 deleted_users 墓碑（D1 Console 查）；③getWebhookInfo 的 last_error_message |
| WELCOME 没收到但消息已进 Topic | WELCOME 属 best-effort 副调用（主链路优先，docs/03 至少一次语义）——偶发丢失可接受，重复消息不重发 |
| Workers Builds 构建失败 | 先看日志 `[provision]` 段（D1 置备）与 7404/10181（见 README 部署排错） |
