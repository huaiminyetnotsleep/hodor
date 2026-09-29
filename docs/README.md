# hodor 设计文档

> One user. One topic. No mix-ups. —— 一个用户,一个话题,消息不串线。

**hodor** 是一个 Telegram Forum Topics 客服消息中继 Bot:

- **技术栈**:TypeScript + Cloudflare Workers + D1;后续阶段可选 Queue、Durable Objects、R2
- **部署方式**:Telegram Webhook,无 VPS;支持 Cloudflare 一键部署按钮(流程与首次引导见 [05](05-webhook-management.md))
- **当前版本形态**:单 Bot、私有 Forum 超级群、每用户一个 Topic、永久保留历史

---

## 名称说明

**hodor** —— 门与守门人:每个用户是一扇门,每个 Topic 是门后的独立会话,Bot 是守门人,负责把每条消息送到正确的门后。

名称取自流行文化中「守门人 / hold the door」的通用意象。本项目是独立项目,与任何版权方无关联,正式发布时不使用原作的 Logo、角色、字体或视觉素材。

---

## 文档导航

全文档 = 本总览 + 13 篇环节文档。每篇聚焦一个实施环节,可独立阅读,按编号顺序递进。

| # | 文档 | 内容 | 对应实施环节 |
|---|------|------|--------------|
| 01 | [架构与组件选型](01-architecture.md) | 总体架构、Phase 演进路径、Worker 模块划分 | 工程脚手架 |
| 02 | [私有 Forum 与 Topic 路由](02-forum-routing.md) | 群配置、用户↔Topic 映射、标题渲染规则、Topic 创建崩溃窗口 | 支持群搭建、Topic 服务 |
| 03 | [消息链路与幂等状态机](03-message-pipeline.md) | 入站/出站链路、幂等状态机、Update 结构解析、错误处理、忽略策略 | 消息管线(全项目核心) |
| 04 | [管理命令与用户管理](04-admin-commands.md) | 管理命令(`/ban` `/unban` `/purge` `/risk` `/unrisk` `/deluser`)、封禁语义、状态唯一来源、命令注册 | 管理命令 |
| 05 | [Webhook 管理与初始化](05-webhook-management.md) | 前置准备清单(建 Bot/建群/管理员 ID)、Secret 体系、初始化与绑定、一键部署、换绑机器人、运维方式 | 初始化与管理端点 |
| 06 | [D1 数据模型](06-data-model.md) | 全部表结构、索引清单、状态值字典、字段约定 | 数据库迁移 |
| 07 | [存储策略与平台限制](07-storage.md) | 媒体三级存储(Telegram 原生 / D1 / R2)、各存储用途边界与官方限制 | 容量规划 |
| 08 | [可靠性与发布](08-reliability.md) | at-least-once 语义、崩溃窗口、灰度发布、Expand/Contract 迁移 | 可靠性设计 |
| 09 | [安全与运维](09-security-ops.md) | 安全清单、滥用防护、监控项、故障处理 SOP、数据查看约定 | 上线检查 |
| 10 | [测试与验收](10-testing.md) | 单元/集成测试清单、第一版验收标准 | 质量保障 |
| 11 | [实施路线图](11-roadmap.md) | Phase 1–4 规划、功能↔文档映射、任务拆分建议 | 任务立项 |
| 12 | [参考资源](12-references.md) | 开源参考项目、Telegram/Cloudflare 官方接口 | — |
| 13 | [Bot 与支持群迁移](13-bot-group-migration.md) | 三种迁移场景、token 安全、广播与 redirect、回滚和消息/媒体边界 | 迁移与换绑 |

未立项的功能意向(如 `/start` 用户验证)记录在 [TODO](TODO.md),立项时按 [11](11-roadmap.md) 的任务粒度展开。

---

## 设计目的

把所有用户消息转发到管理员个人私聊的旧做法,存在以下问题:

- 多个用户消息混在一起,管理员容易回复错用户;
- 会话没有独立边界,封禁/解禁缺少清晰入口;
- 需要 VPS 运行长期进程,Webhook 绑定与发布更新容易丢消息。

hodor 的目标:

1. 每个 Telegram 用户拥有独立 Forum Topic;
2. 管理员在 Topic 中直接回复,不必回复某一条原始消息;
3. 全部管理命令(`/ban`、`/unban`、`/purge`、`/risk`、`/unrisk`、`/deluser`)只能由管理员执行,命令不发给用户;
4. 封禁状态通过 Topic 标题中的 `🔇` 显示;
5. 管理员使用私有超级群,用户不加入该群,只与 Bot 私聊;
6. Cloudflare Workers 接收 Telegram Webhook,不需要 VPS;
7. 支持 Telegram Bot Webhook 回调的绑定、解绑、查询和安全校验(见 [05](05-webhook-management.md));
8. 支持 Worker 灰度发布、数据库兼容迁移和回滚;
9. 永久保留历史:文本与索引存 D1;媒体本体随 Topic 留在 Telegram 存储(`media_file_id` 可重发,存储分级见 [07](07-storage.md)),需要群外自持副本时启用可选的 R2 归档(Phase 3);唯一例外是管理员 `/purge` 显式清除单个用户会话(见 [04](04-admin-commands.md));
10. 对 Telegram Webhook 和 Queue 的重复投递做幂等处理;
11. 支持 Cloudflare「Deploy to Cloudflare」一键部署:fork → 填 5 项表单(3 Secret + 2 非敏感配置)→ 一次无参 `/admin/setup` 完成上线(见 [05](05-webhook-management.md));
12. 支持管理员删除用户(`/deluser`:连身份删除全部数据,被删用户需 `/start` 重新开启)与高危名单(`/risk` `/unrisk`:用户可正常对话,系统持续提示管理员注意,可与封禁叠加,见 [04](04-admin-commands.md))。

### 非目标(第一版不实现)

- Telegram 用户和管理员之间的真实一对一聊天窗口;
- 用户加入管理员群;
- 多 Bot 管理台;
- 复杂的客服分配、排班和 SLA;
- Telegram 外部 API 的严格 exactly-once 保证(见 [08](08-reliability.md))。

---

## 核心原理

### 原理一:一门一户(Topic 即路由键)

```text
Telegram user_id
       │
       ▼
conversation_id
       │
       ▼
message_thread_id / Topic ID
```

正反两个方向都靠这条链路由:用户消息进 Topic,Topic 消息回用户,Topic 本身就是路由键;映射关系由 D1 唯一索引保证,详见 [02](02-forum-routing.md)。

### 原理二:至少一次投递 + 状态幂等

Telegram Webhook 按**至少一次**投递(未确认成功的消息会被重发),因此同一 `update_id` 可能到达多次。hodor 用 `inbox_updates` 表登记每个 Update 的**处理状态**:处理成功的重复直接跳过,处理失败的允许重试——「登记过」不等于「处理过」,失败的消息不会被幂等键吞掉。完整状态机(含 attempts 上限与 failed 语义)**只在 [03](03-message-pipeline.md) 维护一份**,此处不重复。

### 原理三:应用层封禁

封禁是**应用层标志位**(`customers.blocked`),不是 Telegram 群成员封禁——用户根本不加入管理群,无需 `restrictChatMember`。入站命中封禁即静默丢弃(可选提示),唯一事实源只有这一个字段,流程与语义见 [04](04-admin-commands.md)。

---

## 端到端流程总览

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
                     是否 /ban /unban? ──是──> 管理命令(04)
                              │否
                              ▼
                     copyMessage ──> 用户私聊
                     (403 = 用户已拉黑 Bot,见 03)
```

两端逐步的校验、落库与错误处理细节见 [03](03-message-pipeline.md)。

---

## Phase 1 范围声明

Phase 1(MVP)= **Worker + D1 同步处理**:Webhook 请求内同步完成「校验 → 幂等 → 处理 → 落库」,不引入 Queue/outbox;重试依赖 Telegram 对失败 Webhook 的自动重投 + inbox 状态机。不用 Queue 的理由与已知代价(处理时长受限、并发乱序)见 [01](01-architecture.md),Phase 2 起的演进路径见 [01](01-architecture.md) 与 [08](08-reliability.md)。

---

## 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
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
