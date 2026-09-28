# hodor 设计文档

> One user. One topic. No mix-ups. —— 一个用户,一个话题,消息不串线。

**hodor** 是一个 Telegram Forum Topics 客服消息中继 Bot:

- **技术栈**:TypeScript + Cloudflare Workers + D1;后续阶段可选 Queue、Durable Objects、R2
- **部署方式**:Telegram Webhook,无 VPS
- **当前版本形态**:单 Bot、私有 Forum 超级群、每用户一个 Topic、永久保留历史

---

## 名称说明

**hodor** —— 门与守门人:每个用户是一扇门,每个 Topic 是门后的独立会话,Bot 是守门人,负责把每条消息送到正确的门后。

名称取自流行文化中「守门人 / hold the door」的通用意象。本项目是独立项目,与任何版权方无关联,正式发布时不使用原作的 Logo、角色、字体或视觉素材。

> 原项目代号 **Many Gates**,2026-09 更名为 **hodor**。

---

## 文档导航

全文档 = 本总览 + 12 篇环节文档。每篇聚焦一个实施环节,可独立阅读,按编号顺序递进。

| # | 文档 | 内容 | 对应实施环节 |
|---|------|------|--------------|
| 01 | [架构与组件选型](01-architecture.md) | 总体架构、Phase 演进路径、Worker 模块划分 | 工程脚手架 |
| 02 | [私有 Forum 与 Topic 路由](02-forum-routing.md) | 群配置、用户↔Topic 映射、标题渲染规则、Topic 创建崩溃窗口 | 支持群搭建、Topic 服务 |
| 03 | [消息链路与幂等状态机](03-message-pipeline.md) | 入站/出站链路、幂等状态机、错误处理、忽略策略 | 消息管线(全项目核心) |
| 04 | [管理命令与封禁](04-admin-commands.md) | `/ban` `/unban` 流程、封禁语义、状态唯一来源 | 管理命令 |
| 05 | [Webhook 管理与初始化](05-webhook-management.md) | 绑定/解绑、Secret 体系、初始化流程、管理员白名单 | 初始化与管理端点 |
| 06 | [D1 数据模型](06-data-model.md) | 全部表结构、索引清单、状态值字典、字段约定 | 数据库迁移 |
| 07 | [存储策略与平台限制](07-storage.md) | D1/R2/KV/Queue/DO 的用途边界与官方限制 | 容量规划 |
| 08 | [可靠性与发布](08-reliability.md) | at-least-once 语义、崩溃窗口、灰度发布、Expand/Contract 迁移 | 可靠性设计 |
| 09 | [安全与运维](09-security-ops.md) | 安全清单、滥用防护、监控项、故障处理 SOP | 上线检查 |
| 10 | [测试与验收](10-testing.md) | 单元/集成测试清单、第一版验收标准 | 质量保障 |
| 11 | [实施路线图](11-roadmap.md) | Phase 1–4 规划、功能↔文档映射、任务拆分建议 | 任务立项 |
| 12 | [参考资源](12-references.md) | 开源参考项目、Telegram/Cloudflare 官方接口 | — |

---

## 设计目的

把所有用户消息转发到管理员个人私聊的旧做法,存在以下问题:

- 多个用户消息混在一起,管理员容易回复错用户;
- 会话没有独立边界,封禁/解禁缺少清晰入口;
- 需要 VPS 运行长期进程,Webhook 绑定与发布更新容易丢消息。

hodor 的目标:

1. 每个 Telegram 用户拥有独立 Forum Topic;
2. 管理员在 Topic 中直接回复,不必回复某一条原始消息;
3. `/ban`、`/unban` 只能由管理员执行,命令不发给用户;
4. 封禁状态通过 Topic 标题中的 `🔇` 显示;
5. 管理员使用私有超级群,用户不加入该群,只与 Bot 私聊;
6. Cloudflare Workers 接收 Telegram Webhook,不需要 VPS;
7. 支持 Webhook 绑定、解绑、查询和安全校验;
8. 支持 Worker 灰度发布、数据库兼容迁移和回滚;
9. 永久保留历史:文本/索引存 D1,大附件和归档存 R2(Phase 3);
10. 对 Telegram Webhook 和 Queue 的重复投递做幂等处理。

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

- 用户私聊 Bot 的每条消息,复制到「该用户专属的 Topic」;
- 管理员在 Topic 里发的每条普通消息,复制到「该 Topic 绑定的用户」私聊;
- 管理员**不需要回复某一条具体消息**,Topic 本身就是路由键;
- 映射关系由 D1 唯一索引保证,详见 [02](02-forum-routing.md)。

### 原理二:至少一次投递 + 状态幂等

Telegram Webhook 按**至少一次**投递(失败重试),因此同一 `update_id` 可能到达多次。hodor 用 `inbox_updates` 表做幂等登记,并按**处理状态**决定是否重新执行——「登记过」不等于「处理过」,处理失败的消息必须可重放,而不是被幂等键吞掉。状态机详见 [03](03-message-pipeline.md)。

```text
收到 Update ──> 幂等登记 ──> 已处理过? ──是──> 直接 200 跳过
                  │                        │
                  否                       否(未完成/失败)
                  ▼                        ▼
              同步处理 ──成功──> 标记 processed,返回 200
                  │
                失败
                  ▼
          标记失败并返回 5xx ──> Telegram 自动重试 ──┐
              (超过上限进入 failed,人工处理)        │
                  ▲______________________________│
```

### 原理三:应用层封禁

```text
用户私聊消息
      │
      ▼
Worker 查询 customers.blocked
      │
 ┌────┴────┐
 │         │
false     true
 │         │
 ▼         ▼
转发 Topic  拒绝/忽略
```

封禁是**应用层标志位**(`customers.blocked`),不是 Telegram 群成员封禁——用户根本不加入管理群,无需 `restrictChatMember`。封禁唯一事实源只有这一个字段,详见 [04](04-admin-commands.md)。

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

---

## Phase 1 范围声明

Phase 1(MVP)采用 **Worker + D1 同步处理**,不引入 Queue/outbox:

- Webhook 请求内同步完成「校验 → 幂等 → 处理 → 落库」;
- 重试依赖 Telegram 对失败 Webhook 的自动重投 + inbox 状态机;
- 已知代价:处理时长受 Webhook 限制、同一用户并发消息可能乱序(均可接受,Phase 2/4 解决)。

Phase 2 起引入 Queue、outbox、DLQ 的演进路径见 [01](01-architecture.md) 与 [08](08-reliability.md)。

---

## 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v2.0 | 2026-09-24 | 按评审结论修订:幂等状态机重设计、Topic 创建崩溃窗口预案、用户拉黑 Bot 的 403 处理、Schema 补全(admins/audit_logs/索引)、封禁单源化、边界消息策略、429 退避等;单文档拆分为总览 + 12 篇;项目由 Many Gates 更名 hodor |
| v1.0 | 2026-09 | 初版单体设计文档(Many Gates) |
