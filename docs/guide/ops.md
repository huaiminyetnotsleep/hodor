# 运维手册

## Webhook 绑定与解绑

部署后只需绑定一次。Worker 内部用 env 里的 `TELEGRAM_BOT_TOKEN` 调 Telegram API，token 永不出现在 URL 中。

**绑定**：浏览器直接访问（也可用 curl）：

```
https://<worker-url>/setwebhook/<ADMIN_SECRET>
```

Worker 会把 `TELEGRAM_WEBHOOK_SECRET` 作为官方 `secret_token` 一并注册，成功后页面回显 bot 身份（@username / bot ID）供确认。

**解绑**：同路径换成 `deletewebhook`，即 `https://<worker-url>/deletewebhook/<ADMIN_SECRET>`。

::: tip
访问返回 `401`「无效的管理密钥」表示 URL 路径段与 env 中的值不一致（刚更换过，或复制有误）：核对 dashboard 中的 `ADMIN_SECRET` 后用新链接重试即可。错误提示不区分「不存在 / 不正确」，避免枚举探测。
`ADMIN_SECRET` 泄漏的唯一影响是别人能替你重绑 webhook；随时可在 dashboard 换新值，消息流不受影响。
:::

## 更换 Token

### 情况一：同一个 bot 重新生成 token（如泄漏后 revoke）

bot 身份（bot_id）不变，所有数据继续有效：

1. env 里还是旧 token 时，先访问 `deletewebhook` 解绑
2. dashboard 把 `TELEGRAM_BOT_TOKEN` 换成新值
3. 再访问 `setwebhook` 重新绑定

### 情况二：换一个新的 bot

对系统而言这是全新身份：老用户在新 bot 里 `/start` 会创建新记录、新 topic；旧 topic 的绑定仍挂在旧 bot 下，**消息与用户不会自动迁移**（迁移能力属 P2）。

::: warning 严格按顺序操作
否则两个 bot 会同时把 update 推到同一个 URL，而 update 本身不带 bot 身份，Worker 将无法区分消息属于哪个 bot。

```
① 旧 token 还在 env 时 → deletewebhook（解绑旧 bot）
② dashboard 改 TELEGRAM_BOT_TOKEN 为新 bot
③ setwebhook（绑定新 bot）
④ 在旧 bot 里人工广播「客服已迁移，请添加新 Bot @xxx」
   （这步只能人工：换 env 后旧 token 已不在系统里）
```
:::

## 修改密钥的影响

| 改动 | 影响 |
| --- | --- |
| `ADMIN_SECRET` | 零影响，仅管理端点换钥匙；旧链接失效，用新值重新访问即可 |
| `TELEGRAM_WEBHOOK_SECRET` | 改完**必须重新 setwebhook**：旧注册还带着旧 secret，update 校验会 401 |
| `TELEGRAM_BOT_TOKEN` | 见上方「更换 Token」 |

## 健康自检与版本

`GET /health` 返回存活状态与版本号：

```json
{"status":"ok","version":"1.1.0"}
```

部署后或每次更新后建议访问一次，确认服务存活并核对版本号。

::: warning 完整自检尚未实现
逐项检查环境变量、数据库表、Webhook 指向的完整自检（`{"status":"error","failed":[...]}` 形态）规划在 [T07 / 阶段 7](/todo/index.md)。当前排查部署问题可用：`/setwebhook/<ADMIN_SECRET>`（缺 token / secret 会明确报出变量名）、`wrangler tail`（实时日志）、D1 Console（数据核对）。
:::

- **部署与更新**：push 到 main 即自动部署新版本

## 版本管理

发布新版本（维护者）与跟随更新（fork 用户）已独立成页，见[发布与更新](/guide/release.md)。

## 常用 SQL

在 Cloudflare dashboard → Storage & Databases → hodor 数据库 → Console 中直接粘贴执行（与仓库 `scripts/d1-console.sql` 对应）。

**查用户**：

```sql
SELECT user_id, username, first_name, status, is_banned, is_risk,
       is_verified, verified_at, first_seen_at, last_seen_at
FROM users WHERE user_id = 123456789;
```

**查某用户的 topic 与最近消息**：

```sql
SELECT thread_id, status, title, created_at, closed_at
FROM topics WHERE user_id = 123456789;

SELECT direction, content_type, group_msg_id, private_msg_id, created_at
FROM messages WHERE user_id = 123456789
ORDER BY created_at DESC LIMIT 50;
```

**查处理失败的 update（毒丸排查）**：

```sql
SELECT update_id, attempts, created_at
FROM processed_updates
WHERE status = 'failed'
ORDER BY created_at DESC LIMIT 20;
```

**清理指定用户的全部数据**：

```sql
DELETE FROM messages WHERE user_id = 123456789;
DELETE FROM topics  WHERE user_id = 123456789;
DELETE FROM users   WHERE user_id = 123456789;
```

**一键清理全部用户与消息（慎用）**：

```sql
DELETE FROM messages;
DELETE FROM topics;
DELETE FROM users;
-- settings 保留：验证开关与模式不重置
```

::: warning
此 SQL 与 topic 内命令 `/wipealldata` 效果相同，但**没有确认步骤**，粘贴执行即生效；日常建议优先使用带两步危险确认的 `/wipealldata`（见[功能介绍](/guide/features.md)）。
:::

## 故障排查

::: info 适用范围
标 ★ 的为当前阶段（阶段 4）已适用；其余涉及的功能（更多管理命令等）在对应阶段交付后生效。
:::

| 现象 | 排查 |
| --- | --- |
| ★ bot 完全无响应 | ① 先确认 webhook 已绑定：访问 `/setwebhook/<ADMIN_SECRET>` 回显身份即已绑定（`GET /health` 的完整自检 T07 在阶段 7）；② `npx wrangler tail hodor` 实时日志看请求是否到达、有无 401——secret 头不符说明 `TELEGRAM_WEBHOOK_SECRET` 与注册时不一致，重新 setwebhook；③ 日志无请求 = Telegram 侧未推送，检查 webhook 绑定 |
| ★ 消息进群但为空 / 报 sendMessage 400 | `wrangler tail` 看具体 API 报错文案；若为「message to copy not found」类，参考 T21 运行时说明（[TODO](/todo/p1.md)） |
| ★ 验证码收不到 | 用户是否已被 ban（封禁门不发出题）；日志中 sendMessage 是否报 403（用户已停用 / 拉黑 bot）；60 秒内重复消息受提示频控限制（每分钟最多 1 次提示） |
| 消息转发了但没建 topic，或 topic 操作失败 | ★ bot 在群里缺少「管理话题」权限 |
| `/purgemsg` 执行失败（阶段 6 起） | bot 缺少「删除消息」权限 |
| ★ 提示「找不到对应用户」 | topic 是僵尸（绑定行不存在或已被手动清理）：按提示手动关闭或删除该 topic |
| 突然全部请求 429 | CF 免费套餐每日 10 万请求上限用尽（每条消息约消耗 1 次 CF 请求 + 若干 Telegram API 出站调用）；人机验证默认开启已拦截大部分刷量，可调低 `MAX_MESSAGES_PER_MINUTE`，或升级付费计划 |
