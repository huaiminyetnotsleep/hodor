# 09 · 安全与运维

> **hodor 设计文档 · 09/12**
> 上一篇:[08-reliability](08-reliability.md) · 下一篇:[10-testing](10-testing.md) · [返回总览](README.md)

---

## 安全清单

- 必须校验 `X-Telegram-Bot-Api-Secret-Token`(哈希比对,见 [05](05-webhook-management.md));失败返回 401,不留业务日志;
- 管理命令必须校验:管理员白名单(`support_admins`)+ `support_chat_id` + 有效 Topic 映射(见 [04](04-admin-commands.md));
- 管理端点(`/admin/*`)用 `ADMIN_SETUP_SECRET` 或 Cloudflare Access 保护,做基础限速;该 Secret 的配置、携带与使用场景**单一来源**见 [05](05-webhook-management.md)「管理端凭证」一节;
- 用户不加入管理群;支持群不设公开用户名;
- **支持群不得开启「限制保存内容」(protected content)**——可能使 `copyMessage` 链路中断;
- Token、Secret、用户消息正文不写入普通日志;`audit_logs.detail_json` 只存上下文 ID(见 [06](06-data-model.md));
- `GET /health` 健康检查:只返回版本与存活状态,不暴露任何配置。

## 滥用防护(Phase 1 立场)

任何 Telegram 用户私聊 Bot 都会创建 Topic 与 D1 行,存在无限增长面。Phase 1 采取:

- **默认开放 + 监控**:对新用户建 Topic 的速率设置告警(阈值示例:每小时 > 20 个新用户);
- **可选收紧开关** `ALLOW_UNKNOWN_USERS`(默认 `true`):置 `false` 时,未知用户的首条消息静默忽略并记审计,不建 Topic;
- 更细的用户级配额/黑名单留待 Phase 4(见 [11](11-roadmap.md))。

### 后续演进:/start 用户验证(未排期,低优先级)

若滥用升级,可在 `/start` 后加「验证通过才进入建户/绑定流程」的门禁(意向原记录于 TODO.md,设计摘要收敛于此;进入 Phase 4 扩展阶段时再立项):

| 方案 | 机制 | 取舍 |
|------|------|------|
| CAPTCHA(Turnstile / hCaptcha) | 网页或 Telegram Mini App 展示;前端只用 Site Key,Secret Key 仅存服务端,由服务端调供应商接口校验 token | **推荐默认**:证明「大概率是真人」,成本低、无发送费用 |
| 一次性验证码(短信/邮箱 OTP) | 发码回填,确认联系方式 | 有发送成本,且引入新的滥用面(刷短信) |
| 一次性验证链接 / 授权码 | 经可信渠道发放,短时效、单次有效 | 依赖额外的发放渠道 |
| Telegram 登录 / Mini App 签名校验 | 校验 Telegram 签名数据确认用户身份 | 是「身份」校验,不等同「真人」验证,可与 CAPTCHA 互补 |

实现要点:

- 校验结果绑定 `(telegram_user_id, 本次验证流程)`:短时效、一次性使用、防重放;
- 验证通过前**不创建** customer / conversation / Topic;
- 配合频率限制、重复失败锁定与可疑行为风控,必要时才触发 CAPTCHA 或附加验证;
- 定位澄清:CAPTCHA 证明请求大概率来自真人,不负责确认真实身份。

## 监控项

| 指标 | 来源 | 关注点 |
|------|------|--------|
| pending update count / webhook last_error | `getWebhookInfo` 定时拉取 | 投递健康 |
| `inbox_updates WHERE status='failed'` 行数 | D1 巡检 | 手工 DLQ 积压 |
| `inbox_updates WHERE status='pending' AND attempts>0` | D1 巡检 | 重试风暴 |
| 审计事件 `topic_creation_retry` | audit_logs | 重复 Topic 风险(见 [02](02-forum-routing.md) 崩溃窗口) |
| Telegram 429 频率 | client 计数 | 限流/背压 |
| D1 查询延迟与容量 | Cloudflare 仪表盘 | 容量规划(见 07) |
| 新用户建 Topic 速率 | customers 增量 | 滥用防护 |
| `bot_blocked_by_user` 置位频率 | customers 变更 | 触达率异常 |

## 故障处理 SOP(简表)

| 现象 | 处置 |
|------|------|
| `getWebhookInfo.last_error` 非空且持续 | 看 error message 与 URL 是否漂移;必要时重新 `setWebhook`(见 05) |
| failed 行堆积 | 按 `last_error` 分类:临时 → 置回 `pending` 重放;永久 → 记录后 `processed`(见 08) |
| 用户反馈「没收到回复」 | 查该 conversation 最近 outbound 消息与 `bot_blocked_by_user` 标志(见 [03](03-message-pipeline.md) 的 403 处理) |
| 发现重复 Topic | 按 02 的合并步骤处理,并核对 `topic_creation_retry` 审计 |
| 429 告警上升 | 检查是否有用户刷屏;确认退避逻辑生效;必要时临时启用 `ALLOW_UNKNOWN_USERS=false` |
| 疑似误触发 /purge | 未 confirm 即无副作用(confirm 需序号匹配且 10 分钟内);已执行的误删:D1 可 Time Travel 救援,Telegram 侧不可恢复(见 04) |
| 用户要求删除其全部数据 | `/deluser`(见 04):连身份删除全部内容,墓碑不含消息内容;被删用户 `/start` 可重新开启 |

## 备份与恢复

- D1 Time Travel(默认 30 天)覆盖误操作恢复;
- 定期(如每周)导出 D1 全量副本到 R2;
- 恢复演练纳入 Phase 3(归档体系)一并验收。

## 运维边界重申

- 解绑 Webhook 默认不丢 pending updates(见 [05](05-webhook-management.md));
- 历史归档与清理分批执行(Phase 3);
- 任何绑定/解绑、白名单变更都写审计日志,不记录敏感值;
- 表数据查看(用户/消息等)走 Cloudflare 管理通道:Dashboard 的 D1 Console 或 `wrangler d1 execute --remote`,并**统一用脚本维护**——常用只读查询固化进 Makefile,目标命名:`db-customers`(用户列表:封禁状态、最近活跃)、`db-conversations`(会话与 Topic 映射)、`db-messages`(按会话查最近消息)、`db-inbox-failed`(failed 行巡检,与监控项同源);**不在 Worker 暴露数据查询端点**——消息正文属敏感数据,不为其新增公网 HTTP 面;直查库不经过 `audit_logs`,操作者自律:只读、不外发、不贴日志(见 [07](07-storage.md))。

---

下一篇:[10-testing — 测试与验收](10-testing.md)
