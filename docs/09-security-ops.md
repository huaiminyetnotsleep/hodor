# 09 · 安全与运维

> **hodor 设计文档 · 09/12**
> 上一篇:[08-reliability](08-reliability.md) · 下一篇:[10-testing](10-testing.md) · [返回总览](README.md)

---

## 安全清单

- 必须校验 `X-Telegram-Bot-Api-Secret-Token`(哈希比对,见 [05](05-webhook-management.md));失败返回 401,不留业务日志;
- 管理命令必须校验:管理员白名单(`support_admins`)+ `support_chat_id` + 有效 Topic 映射(见 [04](04-admin-commands.md));
- 管理端点(`/admin/*`)用 `ADMIN_SETUP_SECRET` 或 Cloudflare Access 保护,做基础限速;
- 用户不加入管理群;支持群不设公开用户名;
- **支持群不得开启「限制保存内容」(protected content)**——可能使 `copyMessage` 链路中断(M6);
- Token、Secret、用户消息正文不写入普通日志;`audit_logs.detail_json` 只存上下文 ID(见 [06](06-data-model.md));
- `GET /health` 健康检查:只返回版本与存活状态,不暴露任何配置。

## 滥用防护(M5:Phase 1 立场)

任何 Telegram 用户私聊 Bot 都会创建 Topic 与 D1 行,存在无限增长面。Phase 1 采取:

- **默认开放 + 监控**:对新用户建 Topic 的速率设置告警(阈值示例:每小时 > 20 个新用户);
- **可选收紧开关** `ALLOW_UNKNOWN_USERS`(默认 `true`):置 `false` 时,未知用户的首条消息静默忽略并记审计,不建 Topic;
- 更细的用户级配额/黑名单留待 Phase 4(见 [11](11-roadmap.md))。

## 监控项

| 指标 | 来源 | 关注点 |
|------|------|--------|
| pending update count / webhook last_error | `getWebhookInfo` 定时拉取 | 投递健康 |
| `inbox_updates WHERE status='failed'` 行数 | D1 巡检 | 手工 DLQ 积压 |
| `inbox_updates WHERE status='pending' AND attempts>0` | D1 巡检 | 重试风暴 |
| 审计事件 `topic_creation_retry` | audit_logs | 重复 Topic 风险(H2) |
| Telegram 429 频率 | client 计数 | 限流/背压 |
| D1 查询延迟与容量 | Cloudflare 仪表盘 | 容量规划(见 07) |
| 新用户建 Topic 速率 | customers 增量 | 滥用防护 |
| `bot_blocked_by_user` 置位频率 | customers 变更 | 触达率异常 |

## 故障处理 SOP(简表)

| 现象 | 处置 |
|------|------|
| `getWebhookInfo.last_error` 非空且持续 | 看 error message 与 URL 是否漂移;必要时重新 `setWebhook`(见 05) |
| failed 行堆积 | 按 `last_error` 分类:临时 → 置回 `pending` 重放;永久 → 记录后 `processed`(见 08) |
| 用户反馈「没收到回复」 | 查该 conversation 最近 outbound 消息与 `bot_blocked_by_user` 标志(见 03 H3) |
| 发现重复 Topic | 按 02 的合并步骤处理,并核对 `topic_creation_retry` 审计 |
| 429 告警上升 | 检查是否有用户刷屏;确认退避逻辑生效;必要时临时启用 `ALLOW_UNKNOWN_USERS=false` |

## 备份与恢复

- D1 Time Travel(默认 30 天)覆盖误操作恢复;
- 定期(如每周)导出 D1 全量副本到 R2;
- 恢复演练纳入 Phase 3(归档体系)一并验收。

## 运维边界重申

- 解绑 Webhook 默认不丢 pending updates(见 [05](05-webhook-management.md));
- 历史归档与清理分批执行(Phase 3);
- 任何绑定/解绑、白名单变更都写审计日志,不记录敏感值。

---

下一篇:[10-testing — 测试与验收](10-testing.md)
