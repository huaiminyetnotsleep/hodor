# 05 · Webhook 管理与初始化

> **hodor 设计文档 · 05/12**
> 上一篇:[04-admin-commands](04-admin-commands.md) · 下一篇:[06-data-model](06-data-model.md) · [返回总览](README.md)

---

## 概念:Bot Token 与 Webhook Secret

```text
Bot Token
= 调用 Telegram Bot API 的密码

Webhook Secret
= setWebhook 的 secret_token 参数
= Telegram 请求头中的 X-Telegram-Bot-Api-Secret-Token
= 只用于验证 Webhook 请求来源
```

二者绝不放入 URL、前端或普通日志。

**Phase 1 存储(H 级修订:明确两套机制的共存规则)**:

- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`、`ADMIN_SETUP_SECRET` 全部放 **Worker Secrets(env)**,这是 Phase 1 的运行时事实源;
- `bots` 表仍存在,由初始化流程 seed(记录 `telegram_bot_id`、`webhook_key`、`support_chat_id`、`webhook_secret_hash` 等),供外键与查询使用;**`encrypted_bot_token` 允许为 NULL**——多 Bot 主密钥加密体系是 Phase 4 的事,Phase 1 不实现。

## Secret 校验实现

存储与比较均用哈希,避免明文落库与时序侧信道:

```text
存储:webhook_secret_hash = SHA-256(secret)
校验:SHA-256(请求头值) == 存储的哈希
不匹配 → 401,不做任何业务处理、不留任何业务日志
```

Phase 1 运行时的 secret 来自 env,校验为 `SHA-256(header) === SHA-256(env)`。

## 初始化与绑定流程

```text
┌──────────────┐   ADMIN_SETUP_SECRET    ┌──────────┐
│ 管理员管理端  │ ─────────────────────> │ Worker   │
└──────────────┘   + Bot Token + 群 ID    └────┬─────┘
                                             │ getMe(验证 Token)
                                             ▼
                                      seed/更新 bots 行
                                      (telegram_bot_id, support_chat_id,
                                       webhook_secret_hash, status=active)
                                             │
                                             ▼
                                      写入管理员白名单(support_admins)
                                             │
                                             ▼
                              setWebhook
                                url = https://<worker>/telegram/webhook/<webhook_key>
                                secret_token = <secret>
                                allowed_updates = ["message"]
                                             │
                                             ▼
                                      getWebhookInfo(核对 URL / pending / last_error)
                                             │
                                             ▼
                                      写 audit_logs(action = webhook_bind)
```

- 管理端本身用 `ADMIN_SETUP_SECRET`(或 Cloudflare Access)保护,端点做基础限速防探测;
- `webhook_key` 是随机标识符,只用于 URL 混淆,不承担鉴权(鉴权靠 Secret 头);
- Webhook URL 长期稳定,**发布新版本 Worker 不重设 Webhook**(见 [08](08-reliability.md))。

## 管理员白名单(H 级修订:补存储位置)

- 存于 `support_admins` 表(`UNIQUE(bot_id, telegram_user_id)`,见 [06](06-data-model.md)),初始化时写入,后续可增删;
- `/ban`、`/unban` 与出站中继均以此表为准(见 [03](03-message-pipeline.md)、[04](04-admin-commands.md));
- 每次变更写 `audit_logs`;
- 群内真实管理员与白名单**定期核对**(见 [09](09-security-ops.md)):群管理员变动时白名单同步更新。

## 解绑与重绑

```text
deleteWebhook(drop_pending_updates = false)    ← 默认保留积压
```

- 只有明确要丢弃积压消息时才 `drop_pending_updates = true`,并先记录当时 `getWebhookInfo.pending_update_count`;
- 重绑通常直接调用新的 `setWebhook`(upsert 语义),**不必先 delete**;
- 绑定/解绑前后都调用 `getWebhookInfo` 核对:当前 URL、pending 数量、last error、allowed updates;
- 解绑 Webhook **不会**使 Bot Token 失效;Token 泄露只能在 BotFather 重新生成;
- 所有绑定/解绑操作写审计日志(action、时间、操作者;不记录 Token/Secret 值)。

## Worker 路由总览(Phase 1)

```text
POST /telegram/webhook/:webhook_key   → 03 消息管线(Secret 头校验)
POST /admin/setup                     → 初始化/绑定(ADMIN_SETUP_SECRET)
POST /admin/webhook/unbind            → 解绑(ADMIN_SETUP_SECRET)
POST /admin/webhook/status            → getWebhookInfo 透出(ADMIN_SETUP_SECRET)
POST /admin/admins                    → 白名单维护(ADMIN_SETUP_SECRET)
GET  /health                          → 健康检查(无敏感信息,见 09)
```

---

下一篇:[06-data-model — D1 数据模型](06-data-model.md)
