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

`GET /health` 是部署完整性自检端点，逐项检查：

| 检查项 | 内容 |
| --- | --- |
| 环境变量 | 必填变量已配置且格式合法 |
| 数据库 | `HODOR_DB` 绑定可用、六张表已建 |
| Webhook 绑定 | `getWebhookInfo` 确认 webhook 已指向本 Worker 的 `/webhook` |

- 全部通过：`{"status":"ok","version":"x.y.z"}`
- 有未通过项：`{"status":"error","version":"x.y.z","failed":["...逐项失败原因..."]}`

自检不回显任何密钥值，可随时放心访问。部署后或每次更新后建议访问一次，确认全部通过并核对版本号。

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

| 现象 | 排查 |
| --- | --- |
| bot 完全无响应 | ① `GET /health` 查看哪项自检未通过（webhook 未绑定 / 变量缺失 / 建表未完成）；② dashboard 实时日志看是否有 401——secret 头不符说明 `TELEGRAM_WEBHOOK_SECRET` 与注册时不一致，重新 setwebhook |
| 验证码收不到 | 用户是否已被 ban；日志中 sendMessage 是否报 403（用户已停用 / 拉黑 bot） |
| 消息转发了但没建 topic，或 topic 操作失败 | bot 在群里缺少「管理话题」权限 |
| `/purgemsg` 执行失败 | bot 缺少「删除消息」权限 |
| 提示「找不到对应用户」 | topic 是僵尸（数据已被手动清理）：按提示手动关闭或删除该 topic |
| 突然全部请求 429 | CF 免费套餐每日 10 万请求上限用尽（每条消息约消耗 1 次 CF 请求 + 若干 Telegram API 出站调用）；确认人机验证已开启、调低 `MAX_MESSAGES_PER_MINUTE`，或升级付费计划 |
