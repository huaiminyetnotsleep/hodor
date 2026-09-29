# 09 · 安全与运维

> **hodor 设计文档 · 09/13**
> 上一篇:[08-reliability](08-reliability.md) · 下一篇:[10-testing](10-testing.md) · [返回总览](README.md)

---

## 安全清单

- 必须校验 `X-Telegram-Bot-Api-Secret-Token`(哈希比对,见 [05](05-webhook-management.md));失败返回 401,不留业务日志;
- 管理命令必须校验:管理员白名单(`support_admins`)+ `support_chat_id` + 有效 Topic 映射(见 [04](04-admin-commands.md));
- 管理端点(`/public/setwebhook`、`/public/deletewebhook`)用 `ADMIN_SECRET` 或 Cloudflare Access 保护,做基础限速;该 Secret 的配置、携带与使用场景**单一来源**见 [05](05-webhook-management.md)「管理端凭证」一节;
- 用户不加入管理群;支持群不设公开用户名;
- **支持群不得开启「限制保存内容」(protected content)**——可能使 `copyMessage` 链路中断;
- Token、Secret、用户消息正文不写入普通日志;`audit_logs.detail_json` 只存上下文 ID(见 [06](06-data-model.md));
- `GET /health` 健康检查:只返回版本与存活状态,不暴露任何配置。

## 滥用防护(Phase 1 立场)

任何 Telegram 用户私聊 Bot 都会创建 Topic 与 D1 行,存在无限增长面。本产品本就面向陌生人对话——**自动建户是产品本意,不做建户门禁**(原 `ALLOW_UNKNOWN_USERS` 开关已于 2026-09-29 按 PRD「默认可以删除了」意向移除,避免误导)。Phase 1 采取:

- **默认开放 + 监控**:对新用户建 Topic 的速率设置告警(阈值示例:每小时 > 20 个新用户);
- 单用户刷量用 `/ban`(应用层封禁,见 [04](04-admin-commands.md));
- 更细的防护(人机验证、频率限制、用户级配额)见下节与 [11](11-roadmap.md)。

## 人机验证与频率限制(Phase 4 · 步骤 18,设计契约)

防刷与保护 Cloudflare 额度的门禁。Phase 1 无任何验证门禁(陌生人自动建户是产品本意);本节为已合并进设计的功能契约,表示规划而非已实现,落地时按 Expand/Contract 演进(见 [08](08-reliability.md)),排期见 [13](13-implementation-steps.md) 步骤 18。

**门禁位置**:`/start` 之后、建户/绑定流程之前——验证通过前**不创建** customer / conversation / Topic(未通过按 [03](03-message-pipeline.md) 忽略策略同型静默处理)。校验结果绑定 `(telegram_user_id, 本次验证流程)`:短时效、一次性使用、防重放;配合重复失败锁定与可疑行为风控,必要时才触发附加验证。

**机制选型**(通用方案对比):

| 方案 | 机制 | 取舍 |
|------|------|------|
| CAPTCHA(Turnstile / hCaptcha) | 网页或 Telegram Mini App 展示;前端只用 Site Key,Secret Key 仅存服务端,由服务端调供应商接口校验 token | **推荐默认**:证明「大概率是真人」,成本低、无发送费用 |
| 一次性验证码(短信/邮箱 OTP) | 发码回填,确认联系方式 | 有发送成本,且引入新的滥用面(刷短信) |
| 一次性验证链接 / 授权码 | 经可信渠道发放,短时效、单次有效 | 依赖额外的发放渠道 |
| Telegram 登录 / Mini App 签名校验 | 校验 Telegram 签名数据确认用户身份 | 是「身份」校验,不等同「真人」验证,可与 CAPTCHA 互补 |

**PRD 明确的三种验证方式**(部署者在「验证码设置」中选择,与上表的对应关系):

| PRD 方式 | 对应上表方案 | 说明 |
|----------|--------------|------|
| 按钮验证 | 轻量自实现验证(CAPTCHA 的最低成本替代) | `/start` 后 Bot 发送带内联按钮的验证消息,点击即通过;成本最低,防脚本能力最弱 |
| 数学题验证 | 轻量自实现验证 | Bot 发送简单算术题,用户回填答案;无第三方依赖 |
| TGuard 验证 | 第三方 CAPTCHA(经 Telegram Mini App 打开) | 需在「TGuard API 设置」中配置 API 地址与密钥 |

**开关命令 `/verifyon` / `/verifyoff`**:命令契约见 [04](04-admin-commands.md) Phase 4 命令节;状态唯一来源 `bots.verification_enabled`(见 [06](06-data-model.md)),关闭后 `/start` 跳过验证机制直接建户(PRD 推荐默认开启)。

**频率限制 `MAX_MESSAGES_PER_MINUTE`**:每用户每分钟消息条数上限(环境配置);超限后该用户进入「需重新验证」状态,下一条消息触发验证流程——给重新验证入口,不做静默丢弃。跨请求计数设施 Phase 1 不具备(KV 禁用于计数,见 [07](07-storage.md)),与 per-Topic DO(步骤 17)一并落地或以 D1 条件更新实现,立项时评估。

**重新验证的触发**:`/deluser` 删除的用户重新 `/start` 需再次通过验证;超限触发见上条。

**定位澄清**:CAPTCHA 证明请求大概率来自真人,不负责确认真实身份;「身份」级校验见机制选型表的 Telegram 签名方案,可与 CAPTCHA 互补。

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
| 429 告警上升 | 检查是否有用户刷屏;确认退避逻辑生效;对刷量用户执行 `/ban`(应用层封禁,见 [04](04-admin-commands.md)) |
| 疑似误触发 /purgemsg | 未 confirm 即无副作用(confirm 需序号匹配且 10 分钟内);已执行的误删:D1 可 Time Travel 救援,Telegram 侧不可恢复(见 04) |
| 用户要求删除其全部数据 | `/deluser`(见 04):连身份删除全部内容,墓碑不含消息内容;被删用户 `/start` 可重新开启 |

## 备份与恢复

- D1 Time Travel(默认 30 天)覆盖误操作恢复;
- 定期(如每周)导出 D1 全量副本到 R2;
- 恢复演练纳入 Phase 3(归档体系)一并验收。

## 运维边界重申

- 解绑 Webhook 默认不丢 pending updates(见 [05](05-webhook-management.md));
- 历史归档与清理分批执行(Phase 3);
- 任何绑定/解绑、白名单变更都写审计日志,不记录敏感值;
- 表数据查看(用户/消息等)走 Cloudflare 管理通道:Dashboard 的 D1 Console,常用只读查询固化进 `scripts/d1-console.sql`(客户、Bot 绑定、管理员、会话与 Topic 映射、消息截断、inbox 状态机总览、failed 行巡检与监控项同源、审计、已删除用户、会话活跃度);**不在 Worker 暴露数据查询端点**——消息正文属敏感数据,不为其新增公网 HTTP 面;直查库不经过 `audit_logs`,操作者自律:只读、不外发、不贴日志(见 [07](07-storage.md))。

---

下一篇:[10-testing — 测试与验收](10-testing.md)
