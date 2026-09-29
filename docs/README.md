# hodor 设计文档

> One user. One topic. No mix-ups. —— 一个用户,一个话题,消息不串线。

**hodor** 是一个 Telegram Forum Topics 客服消息中继 Bot:用户与 Bot 私聊,每条消息按用户映射到私有超级群中的一个独立 Topic;管理员在 Topic 内直接回复,经 Bot 送回对应用户,形成双向客服对话。

- **技术栈**:TypeScript + Cloudflare Workers + D1;后续阶段可选 Queue、Durable Objects、R2
- **部署方式**:Telegram Webhook,无 VPS;支持 Cloudflare 一键部署,零命令自动绑定在规划中(见 [05](05-webhook-management.md))
- **需求基线**:[prd.md](prd.md) 是产品原始需求,**保持原样不作设计展开**;本目录其余文档是它的设计与实现展开,追踪关系见下方「PRD 映射」

---

## 一、产品目标(提炼自 PRD)

把「所有用户消息涌进管理员私聊、回复靠引用、容易串线」的旧模式,改造成**一门一户的 Topic 客服**:

1. 每个 Telegram 用户 ↔ 一个独立 Topic,双向聊天,消息不串线;
2. 支持多个管理员,在 Topic 中直接对话,不必回复某条原始消息;
3. 管理动作(封禁/高危/清除/删除)全部以命令完成,用户不可见;
4. 免费(Workers Free 可运行)、自部署(消息不经第三方)、一键部署零代码改动;
5. Bot 与支持群可随时换绑(换绑 Runbook 见 [05](05-webhook-management.md));无缝迁移已延后(见 [11](11-roadmap.md)「延后意向」);
6. 防滥用:人机验证 + 消息频率限制(意向,见 [09](09-security-ops.md) 演进节)。

### PRD 亮点 → 设计落点

| # | PRD 亮点 | 设计落点 | 交付阶段 |
|---|----------|----------|----------|
| 1 | CF 免费 | Workers Free 可运行;额度与限制核算见 [07](07-storage.md) | P1 已达成 |
| 2 | 自部署,不怕消息泄露 | 数据只在自部署 Worker + D1 + 私有群;Secret 体系见 [05](05-webhook-management.md),安全清单见 [09](09-security-ops.md) | P1 已达成 |
| 3 | 一键部署,0 改动代码 | Deploy Button + 声明式配置([01](01-architecture.md));零命令自动绑定([05](05-webhook-management.md)) | 步骤 13,绑定架构重设计后立项(见 [13](13-implementation-steps.md)) |
| 4 | 分组管理、多管理员、直接对话 | Topic 即会话([02](02-forum-routing.md));双向中继([03](03-message-pipeline.md));白名单多管理员([04](04-admin-commands.md)) | P1 已实现 |
| 5 | 多机器人 | Phase 1 单 Bot 基线;多 Bot 架构见 [05](05-webhook-management.md)、[11](11-roadmap.md) | P4(步骤 20) |
| 6 | Bot/群随时换绑,数据保留 | 跨 Bot 换绑 Runbook([05](05-webhook-management.md)) | 换绑 P1 支持;无缝迁移延后(见 [11](11-roadmap.md)「延后意向」) |
| 7 | 验证机制(防刷/频率限制/开关) | 人机验证与频率限制设计见 [09](09-security-ops.md),开关命令见 [04](04-admin-commands.md) | P4 交付(步骤 18,设计已并入) |
| 8 | 多种命令支持 | 六条管理命令见 [04](04-admin-commands.md) | 六条 P1 已实现;`/help`、`/verifyon` `/verifyoff` 契约见 [04](04-admin-commands.md),P4 交付(步骤 18/19) |

### 配置变量清单(必填/选填 + 用途)

| 变量 | 必填 | 用途 | 存放 |
|------|------|------|------|
| `TELEGRAM_BOT_TOKEN` | **必填** | Bot API 调用凭证(BotFather 发放):setWebhook、copyMessage、Topic 管理全靠它 | Worker Secret(见 [05](05-webhook-management.md)) |
| `TELEGRAM_WEBHOOK_SECRET` | **必填** | 数据面鉴权:校验 Telegram 回调头 `X-Telegram-Bot-Api-Secret-Token`(SHA-256 比对);三个 Secret 必须互异 | Worker Secret |
| `ADMIN_SECRET` | **必填** | 管理面鉴权:调用 `/public/setwebhook`、`/public/deletewebhook` 时作 Bearer | Worker Secret |
| `SUPPORT_CHAT_ID` | **必填** | 私有支持群 chat_id(`-100` 开头):Topic 所在群,双向路由依据;setwebhook 时写入 bots 行 | 普通环境变量(非敏感) |
| `ADMIN_IDS` | **必填** | 管理员 user_id 白名单(逗号分隔):setwebhook 时全量同步进 `support_admins`;增删 = 改此值后重跑 setwebhook | 普通环境变量(非敏感) |
| `MAX_ATTEMPTS` | 选填(缺省 8) | inbox 处理尝试上限:超过即置 `failed` 停止 Telegram 重投,转人工 DLQ(见 [03](03-message-pipeline.md)) | 环境变量 |
| `PREFIX` | 不需要(不再是配置项) | PRD 的 URL 前缀意向已由设计吸收:数据面 = 随机 `webhook_key`(只混淆不鉴权),管理面 = 固定 `/public` 字面量前缀 | — |
| `MAX_MESSAGES_PER_MINUTE_ENV` | 未实现(P4 预定) | 每分钟消息频率限制,超限触发重新验证;随验证体系落地(见 [09](09-security-ops.md)、[13](13-implementation-steps.md) 步骤 18) | — |

### PRD 意向与设计决策的出入(透明记录)

| PRD 意向 | 设计决策 | 依据 |
|----------|----------|------|
| `setwebhook`/`deletewebhook` 支持把 Token 放 URL 路径 | **拒绝**:Secret/参数不入 URL(日志留存、链接预览误触发);变更操作统一 POST + Bearer | [05](05-webhook-management.md) |
| 广播「客服已迁移」只能人工发 | P1 保持人工/脚本(换绑 Runbook 步骤①);广播自动化随无缝迁移延后(见 [11](11-roadmap.md)「延后意向」) | [05](05-webhook-management.md)、[11](11-roadmap.md) |
| R2 存图片/视频/附件 | 媒体默认主存是 **Telegram 原生(T0,零成本)**;R2 降为可选的独立归档层 | [07](07-storage.md) |
| 使用 VitePress 建文档站 | 现阶段 Markdown 直读;站点化未立项 | — |
| 查询用户/消息、清理数据的 SQL 脚本 | 只读查询固化进 `scripts/d1-console.sql`(见 [09](09-security-ops.md));清理走 `/purgemsg` `/deluser` 命令,不做脚本直删 | [04](04-admin-commands.md)、[09](09-security-ops.md) |

---

## 二、总体设计

### 架构一张图(Phase 1 基线)

```text
用户私聊 Bot ──> Telegram Webhook ──> Cloudflare Worker
                                       │ Secret 校验 → inbox 幂等 → 业务处理 → 落库
                     ┌─────────────────┴─────────────────┐
                     ▼                                   ▼
              D1(唯一事实源)                     Telegram Bot API(copyMessage)
       用户/会话/消息/状态/inbox/审计                     │
                                                       ▼
                                          私有 Forum 超级群(每用户一个 Topic)
```

- Worker 在 Webhook 请求内**同步**完成「校验 → 幂等 → 处理 → 落库」,不引入 Queue;
- **Bot 与群都是可替换轴**:Webhook 按 `webhook_key` 定位 bot 行,群坐标存在 conversation 行里——数据不绑 Token、不绑特定群,换绑不要求改 pipeline;
- 模块划分、Phase 2–4 架构演进与不用 Queue 的理由见 [01](01-architecture.md)。

### 四条核心原理(细节单一来源在各篇,此处只给直觉)

1. **一门一户,Topic 即路由键**:`user_id → conversation_id → Topic ID` 正反两个方向都靠这条链路由,映射由 D1 唯一索引保证(见 [02](02-forum-routing.md));
2. **至少一次投递 + 状态幂等**:Telegram Webhook 会重投,`inbox_updates` 按处理状态(而非「行是否存在」)决定跳过或重试——「登记过」≠「处理过」,失败的消息不会被幂等键吞掉(状态机只在 [03](03-message-pipeline.md) 维护一份);
3. **应用层封禁**:封禁是 `customers.blocked` 标志位,不是 Telegram 群封禁——用户根本不加入管理群;高危名单 `watchlisted` 与之正交可叠加,状态唯一来源表见 [04](04-admin-commands.md);
4. **Bot 轴与群轴解耦**:业务数据只挂内部 `bots.id` 与 conversation 的群坐标,**不绑 Token、不绑特定群**——Bot 与支持群是两根可独立替换的轴,换 Bot、换群都是「更新绑定行、数据不动」,pipeline 与历史数据不动(换绑 Runbook 见 [05](05-webhook-management.md);无缝迁移已延后,见 [11](11-roadmap.md)「延后意向」)。

---

## 三、端到端流程

### 用户消息 → Topic

```text
用户私聊 Bot ──> Telegram Webhook ──> Worker
                                        │
                        校验 Secret ────┤
                                        │
                        inbox 幂等登记 ─┤
                                        │
                        查/建用户 ──────┤
                        查/建 Topic ────┤   ┌─────────────┐
                        copyMessage ────┼──>| 私有群 Topic │
                                        │   └─────────────┘
                        落库 messages ──┘
```

### 管理员回复 → 用户

```text
管理员在 Topic 发消息 ──> Telegram Webhook ──> Worker
                                              │
                     校验:群 ID + thread ID ──┤
                     + 管理员白名单            │
                                              │
                     是否管理命令? ──是──> 管理命令(04)
                              │否
                              ▼
                     copyMessage ──> 用户私聊
                     (403 = 用户已拉黑 Bot,见 03)
```

两端逐步的校验、落库与错误处理细节见 [03](03-message-pipeline.md)。

---

## 四、文档导航(每篇 = 一个功能域的设计与实现)

| # | 文档 | 功能域 | 内容 |
|---|------|--------|------|
| 01 | [架构与组件选型](01-architecture.md) | 架构 | 总体架构、Bot 轴与群轴解耦、Phase 演进、模块划分、一键部署设计约束 |
| 02 | [私有 Forum 与 Topic 路由](02-forum-routing.md) | Topic 路由 | 群配置、用户↔Topic 映射、标题渲染规则、创建崩溃窗口 |
| 03 | [消息链路与幂等状态机](03-message-pipeline.md) | 消息链路(核心) | 入站/出站链路、幂等状态机、Update 解析、错误分类、忽略策略 |
| 04 | [管理命令与用户管理](04-admin-commands.md) | 管理命令 | `/ban` `/unban` `/purgemsg` `/risk` `/unrisk` `/deluser`、封禁/高危语义、状态唯一来源 |
| 05 | [Webhook 管理与初始化](05-webhook-management.md) | 绑定与部署 | Secret 体系、前置准备清单、初始化绑定、一键部署、换绑 Runbook、运维方式 |
| 06 | [D1 数据模型](06-data-model.md) | 数据模型 | 全部表结构、索引清单、状态值字典 |
| 07 | [存储策略与平台限制](07-storage.md) | 存储策略 | 三级存储(Telegram/D1/R2)、KV/Queue/DO 边界、平台限制 |
| 08 | [可靠性与发布](08-reliability.md) | 可靠性 | 投递语义、重试闭环、滚动发布、Expand/Contract 迁移 |
| 09 | [安全与运维](09-security-ops.md) | 安全运维 | 安全清单、滥用防护、用户验证演进、监控项、故障 SOP、备份 |
| 10 | [测试与验收](10-testing.md) | 质量保障 | 单元/集成测试清单、第一版验收标准 |
| 11 | [实施路线图](11-roadmap.md) | 阶段规划 | Phase 1–4 规划、功能↔文档映射、阶段间承诺 |
| 12 | [参考资源](12-references.md) | 参考 | 开源参考项目、Telegram/Cloudflare 官方接口 |
| 13 | [从 0 到 1 实施步骤](13-implementation-steps.md) | 实施步骤 | 增量交付原则、里程碑、步骤表(功能/依赖/完整性验收线/状态) |

基线文档:[prd.md](prd.md)(原始需求,不改)。原 TODO 中的功能意向已全部并入各篇功能设计(验证体系见 [09](09-security-ops.md),`/help` 与验证开关见 [04](04-admin-commands.md),信息卡见 [02](02-forum-routing.md),欢迎语见 [03](03-message-pipeline.md),多 Bot 见 [05](05-webhook-management.md)),排期统一见 [13](13-implementation-steps.md)。

---

## 五、从 0 到 1 的实施路径

整个项目不可能一次建成,按「每一步结束系统都完整可用」的增量方式推进:

```text
M0 地基(脚手架+D1+client+webhook+inbox)
  → M1 单向可达(用户消息落 Topic)
  → M2 双向客服(管理员回复到用户)
  → M3 可封禁(/ban /unban + 标题图标)
  → M4 管理命令全集(/purgemsg /risk /unrisk /deluser)
  → M5 可绑定可运维(/admin 端点 + 审计 + 脚本)
  → M6 Phase 1 MVP v1.0(测试全集 + 部署演练)
  → M7 部署体验闭环(一键部署/自动绑定)
  → Phase 2 可靠性(Queue/outbox) → Phase 3 归档(R2,可选)
  → Phase 4 扩展(DO/验证体系/多 Bot)
```

完整步骤表(步骤、功能、依赖、**每步的功能完整性保证**、当前状态)见 **[13 · 从 0 到 1 实施步骤](13-implementation-steps.md)**;阶段规划与功能↔文档映射见 [11](11-roadmap.md)。

---

## 六、功能实现清单

> 判定基准 = 代码主干通过 [10](10-testing.md) 验收。✅ 已实现 · 🔄 进行中/部分完成 · ⬜ 未实现。当前:**24 项已实现 · 2 项进行中 · 26 项未实现**(截至 2026-09-29)。实施顺序与验收线见 [13](13-implementation-steps.md)。

### Phase 1 · MVP(基础链路与管理)

- [x] Telegram Webhook 接入:Secret 头 SHA-256 校验(失败 401 无副作用)、`allowed_updates=["message"]`(03/05)
- [x] inbox 幂等状态机:按处理状态幂等、5xx 重试闭环、`MAX_ATTEMPTS` 超限转人工 DLQ(03/08)
- [x] 陌生人自动建户 + `/start` 欢迎语(WELCOME;无门禁,防滥用立场见 09)
- [x] 每用户一个 Topic:自动创建、`creating` 崩溃窗口预案、General 公告区不绑用户(02)
- [x] 入站中继:用户消息(文本/图片/视频/文件等全类型)copyMessage 进 Topic(03)
- [x] 出站中继:管理员在 Topic 直接回复 → 用户私聊,无需引用原消息(03)
- [x] 用户拉黑 Bot 的 403 处理:一次性「无法送达」告警 + 用户回归自动恢复(03)
- [x] Topic 标题动态渲染:👤/⚠️/🔇 + 昵称 + 完整用户 ID + #序号,改名自动刷新,128 字符截断(02)
- [x] Telegram API 错误分类:429 `retry_after` 退避 / 403 / 400 毒丸不重试 / 5xx 重试(03)
- [x] 多管理员:`support_admins` 白名单校验(实现为表;设计已收敛为 `ADMIN_IDS` env 全量同步,05)
- [x] `/ban` `/unban` 应用层封禁:标题 🔇、命令不进 copyMessage、命令消息删除(04)
- [x] `/risk` `/unrisk` 高危名单:⚠️ 标题 + 置位提示 + 24h 限频 WATCH_NOTICE,与封禁正交可叠加(04)
- [x] `/purgemsg` 清理用户全部消息:两步确认、审计先行、整题删除、customer 保留(04)——🔄 实现仍为 `/purge`,重命名待办
- [x] `/deluser` 删除用户:墓碑门禁、连身份删除、`/start` 重开并继承高危标记(04)
- [x] 命令注册 setMyCommands:群级 scope、失败非致命、输入辅助(04)
- [x] 审计日志:绑定/解绑/白名单/管理命令全覆盖,不含 Token/Secret/消息正文(06/09)
- [x] D1 数据模型:8 表 + 唯一索引 + 幂等迁移(06)
- [x] `/health` 验活端点:只返回版本与存活,不泄露配置(09)
- [x] 管理端点(绑定/解绑)——🔄 实现为 `/admin/setup`、`/admin/webhook/unbind` 等;设计已收敛为 `/public/setwebhook`、`/public/deletewebhook` 并移除 status/admins 端点(05)
- [x] 只读运维查询脚本 `scripts/d1-console.sql`(09)
- [x] 自动化测试全集:148 例,覆盖幂等/路由/中继/命令/端点/Schema(10)
- [x] 跨 Bot 换绑 Runbook:数据零丢失、幂等台账归档、老媒体按群内坐标重放(05)
- [x] 部署链路:wrangler 声明式配置、D1 自动置备、Workers Builds push 自动部署、回滚不回滚库(01/05/08)
- [x] 一键部署按钮(Deploy to Cloudflare):自动建仓/置备资源(05)
- [ ] `CLOSE_TOPIC_ON_BAN` 可选关题:待真机实测「Bot 能否向 closed Topic 发言」后决定启用或永久移除(04;根 README 附带实测项)

### 交付中(Phase 1 收尾)

- [ ] 零命令自动绑定:绑定无参化、provision/deploy 脚本、Deploy Button 首次引导(01/05;13 步骤 13)——前次任务方案已撤销,绑定架构重设计中
- [ ] 人工回归 V4–V10:docs/10 真机 21 条场景分期执行,换绑/灰度类顺延(10)
- [ ] 待办代码批次:删除 `ALLOW_UNKNOWN_USERS`、`/purge` → `/purgemsg`、`/admin/*` → `/public/setwebhook` `/public/deletewebhook` 端点收敛(04/05/09)

### Phase 2 · 可靠性(未开始)

- [ ] Queue 异步解耦:Webhook 只做登记入队,Consumer 复用同一 pipeline(01/08;14 步骤 14)
- [ ] outbox 发送幂等与重试兜底(06/08)
- [ ] DLQ 自动化:失败重放工具化,替代手工 SQL(08/09)
- [ ] Topic 创建失败恢复强化(02/11)
- [ ] 用户消息编辑同步(edited_message,Phase 1 忽略,可选)(03)
- [ ] 灰度发布演练:gradual deployments 分阶段 + 回滚(08)
- [ ] Cloudflare Access 管理面加固(可选,与 ADMIN_SECRET 二选一或叠加)(09)

### Phase 3 · 独立归档(可选,未开始)

- [ ] R2 归档:附件原件(`getFile`,超 20 MB 需本地 Bot API server)与老化 Update 落桶(07)
- [ ] `/purgemsg` `/deluser` 连带删除 R2 对象(04/07)
- [ ] D1 定期导出备份到 R2 + 恢复演练(09)
- [ ] D1 容量治理:接近阈值迁移旧正文,保留索引与 R2 指针(07)

### Phase 4 · 扩展(未开始)

- [ ] per-Topic Durable Objects:消除并发乱序与 Topic 创建竞争(01/07/08;14 步骤 17)
- [ ] 人机验证体系:`/verifyon` `/verifyoff` 开关,按钮验证 / 数学题 / TGuard(Mini App) 三方式,验证通过才建户(09/04;14 步骤 18)
- [ ] `MAX_MESSAGES_PER_MINUTE` 频率限制:超限触发重新验证(09)
- [ ] `/help` 管理员帮助命令(04)
- [ ] Topic 置顶用户信息卡片:用户名 / 用户 ID / 首次联系时间(02)
- [ ] 欢迎语增强:附项目名称、项目地址与「直接对话即可」使用方式(03)
- [ ] 多 Bot 架构:`encrypted_bot_token` 主密钥加密、多 webhook key 路由(05/06;13 步骤 20)
- [ ] 双 Bot 并行过渡:老 Bot 继续收、新 Bot 回复(05/06;13 步骤 20)
- [ ] 群/Bot 无缝迁移(延后):migration_token、广播 outbox、legacy_redirect、generation 代际、历史回填——立项时重新设计并另立设计文档,见 [11](11-roadmap.md)「延后意向」
- [ ] Web 管理台(条件触发:多 Bot 常态化 / 非技术人员接管 / 运营看板需求,05)
- [ ] 用户标签与统计(11)
- [ ] 多管理员分配/客服排班(PRD 非目标,Phase 4 另评)(11)
- [ ] 文档站点化(VitePress;现为 Markdown 直读,PRD 意向未立项)

---

## 七、Phase 1 范围声明

Phase 1(MVP)= **Worker + D1 同步处理**:Webhook 请求内同步完成「校验 → 幂等 → 处理 → 落库」,不引入 Queue/outbox;重试依赖 Telegram 对失败 Webhook 的自动重投 + inbox 状态机。不用 Queue 的理由与已知代价见 [01](01-architecture.md),演进路径见 [01](01-architecture.md) 与 [08](08-reliability.md)。

### 非目标(第一版不实现)

- Telegram 用户和管理员之间的真实一对一聊天窗口;
- 用户加入管理员群;
- 多 Bot 管理台;
- 复杂的客服分配、排班和 SLA;
- Telegram 外部 API 的严格 exactly-once 保证(见 [08](08-reliability.md))。

---

## 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v3.7 | 2026-09-29 | 删除迁移设计文档(原 docs/13)并延后无缝迁移:群/Bot 无缝迁移(逐会话 Topic 迁移、migration_token、广播 outbox、legacy_redirect、generation 代际、历史回填)列入 11「延后意向」,立项时重新设计;实施步骤文档改号为 13(步骤 20/21 调整、步骤 13 状态回退待重新立项),01/02/05/06/11/12 引用与表述同步;全库篇目编号统一为 N/13 |
| v3.6 | 2026-09-29 | 总览新增「功能实现清单」:按 Phase 1 / 交付中 / Phase 2 / Phase 3 / Phase 4 分组的 checkbox 全集(24 ✅ / 3 🔄 / 26 ⬜),逐项标注设计文档出处,作为功能实现状态的单一核对入口;根 README 进度段指向该清单 |
| v3.5 | 2026-09-29 | 配置变量清单标注必填/选填与用途:总览表重构为「配置变量清单」(5 必填 + 1 选填;`PREFIX` 不再是配置项、`MAX_MESSAGES_PER_MINUTE` 未实现);05 前置汇总表增必填/用途列并清理残留的「请求体显式给」表述;移除 `ALLOW_UNKNOWN_USERS`(采纳 PRD「默认可以删除了」意向,陌生人自动建户是产品本意,防滥用 = 监控告警 + `/ban` + Phase 4 验证体系;代码移除随实现批次);根 README 变量表与 `.dev.vars.example` 同步 |
| v3.4 | 2026-09-29 | 管理面收敛(对齐 PRD 最小接口):绑定/解绑端点按 PRD 定名 `/public/setwebhook`、`/public/deletewebhook`(Token 恒取 env,URL 带 Token 变体仍拒绝;`/public` 为固定字面量前缀);移除 `/admin/webhook/status`(排障直接调 Telegram getWebhookInfo,`/health` 仅验 Worker 活性)与 `/admin/admins`(白名单以 `ADMIN_IDS` env 为唯一来源,setwebhook 全量同步 + 差集审计);白名单节、换绑 Runbook、一键部署链路同步;当前实现仍为旧端点,收敛随代码变更执行(见 05 命名注) |
| v3.3 | 2026-09-29 | /purge 对齐 PRD 定名与语义:`/purgemsg`「清理和该用户的所有消息」——机制不变(48h 消息删除限制下,整题删除仍是清空全部消息的唯一手段,customer 保留、会话重开),04 补充方案取舍与「当前实现仍为 /purge」命名注;03/02/06/09/10/11/14 同步 |
| v3.2 | 2026-09-29 | 架构更新(迁移驱动的解耦):新增原理四「Bot 轴与群轴解耦」——数据不绑 Token/群,Bot 与群是两根可独立替换的轴;01 增设「Bot 轴与群轴:从第一天解耦」约束节(两轴图示 + 对 Phase 1 的代码纪律)、组件职责增迁移控制面(P4)、模块树增 migration 预留槽位;02/05/06/13/14 同步解耦引用;06 固化迁移结构边界(Phase 4 预定) |
| v3.1 | 2026-09-29 | TODO 意向全部并入功能设计并删除 TODO.md:09「人机验证与频率限制」升为正式功能节(门禁位置/三方式/开关命令/限频/重验触发);04 新增 Phase 4 命令契约(`/help`、`/verifyon` `/verifyoff`);02 新增会话信息卡置顶;03 文案模板增 `HELP` 并标注 `WELCOME` 增强;05 新增多 Bot 架构契约;06 增预定列 `verification_enabled` 与审计动作 `verify_on`/`verify_off`;11/14 引用同步 |
| v3.0 | 2026-09-29 | 总览重构:新增「产品目标」与 PRD 映射(亮点/配置变量/设计出入,prd.md 保持原样);文档导航改为「每篇 = 一个功能域」;新增 [14 · 从 0 到 1 实施步骤](14-implementation-steps.md)(增量交付原则、里程碑、含完整性验收线的步骤表);09 收录 PRD 三种验证方式与频率限制(未排期);TODO 改为按步骤索引的意向清单;篇目编号统一为 N/14 |
| v2.12 | 2026-09-28 | 新增 /risk /unrisk 高危名单(04):正常对话 + ⚠️ 标题与 24h 限频提示,与封禁正交可叠加;新增 /deluser 删除用户(04):墓碑门禁,全部数据连身份删除,/start 重新开启并继承高危标记;06 增列/增表,03/02/09/10/11 同步 |
| v2.11 | 2026-09-28 | 新增管理命令 /purge(04):清除单用户全部会话数据——整题删除(deleteForumTopic)+ D1 硬删,customer 保留;无状态二次确认(confirm <序号>);审计先行与崩溃预案;03/02/06/09/10/11 同步 |
| v2.10 | 2026-09-28 | 决策:引导配置入环境变量——新增非敏感变量 SUPPORT_CHAT_ID / ADMIN_IDS(wrangler.jsonc [vars]),setup 支持空请求体(缺省回退 env,请求体优先);明确「env 是引导通道,D1 是事实源」;01/05 同步 |
| v2.9 | 2026-09-28 | 决策:不做 Makefile 管理封装,05 撤下示例;管理端点保持直接 curl 调用;只读数据查询脚本(09)不受影响 |
| v2.8 | 2026-09-28 | 05 实操补「参数为什么不放进 URL」:Secret/参数入 URL 的日志留存与链接预览误触发风险;变更操作一律 POST + Bearer;"一键执行"由 Makefile 目标(setup/status/unbind)提供 |
| v2.7 | 2026-09-28 | 05 新增「实操」小节:setup / status / unbind 三端点 curl 示例,澄清绑定解绑不经 BotFather、Webhook 地址由 setup 自动注册;统一 Token 表述——只走 Secret,不进请求体 |
| v2.6 | 2026-09-28 | 05 补「部署后的功能更新」:按钮仅为首次置备,更新走 Workers Builds push 自动部署(fork 用 Sync fork;迁移幂等;含回滚与 Preview 说明);08/12 补交叉引用 |
| v2.5 | 2026-09-28 | 05 新增「前置准备清单」:BotFather 建 Bot 与 privacy 说明、建群/开话题/权限勾选、绑 Webhook 前经 getUpdates 取 chat_id 与管理员 ID、Secret 汇总;02 与 05 互链 |
| v2.4 | 2026-09-28 | 新增跨 Bot 换绑 Runbook(05):数据零丢失迁移原理、幂等台账归档约束(03/06)、老媒体经群内坐标重放(07)、换绑验收项(10) |
| v2.3 | 2026-09-28 | 新增三项:一键部署设计约束与 Deploy Button 首次引导(01/05);媒体存储分级——Telegram 原生存储为默认主存,R2 降为可选独立归档(07/03/06/10/11);/start 用户验证从 TODO 收敛进 09(未排期) |
| v2.2 | 2026-09-28 | 全库文档串联:合并跨篇重复内容,状态机/标题渲染/崩溃窗口/运维决策等改为单一来源 + 互链;移除内部评审标记;命名叙述统一为 hodor |
| v2.1 | 2026-09-28 | 文档整理:Topic 标题加入 Telegram 用户 ID(02);Update 结构速查(03);命令注册 setMyCommands(04);管理端凭证 ADMIN_SETUP_SECRET 配置与用途、运维方式决策——不做管理 UI、脚本化运维与数据查看(05/09/11);原理二补充通俗说明;参考资料补全 |
| v2.0 | 2026-09-24 | 按评审结论修订:幂等状态机重设计、Topic 创建崩溃窗口预案、用户拉黑 Bot 的 403 处理、Schema 补全(admins/audit_logs/索引)、封禁单源化、边界消息策略、429 退避等;单文档拆分为总览 + 12 篇 |
| v1.0 | 2026-09 | 初版单体设计文档 |
