# 01 · 架构与组件选型

> **hodor 设计文档 · 01/13**
> 上一篇:[总览](README.md) · 下一篇:[02-forum-routing](02-forum-routing.md) · [返回总览](README.md)

---

## Phase 1 总体架构(MVP,本文档的基准架构)

Phase 1 = **Worker + D1**,同步处理,不引入 Queue:

```text
┌────────────────────┐
│ Telegram 用户       │
│ 私聊 Bot            │
└─────────┬──────────┘
          │ Telegram Bot API(Webhook 投递)
          ▼
┌──────────────────────────────────────┐
│ Cloudflare Worker(单个 Webhook 请求内)│
│                                      │
│ 1. 校验 X-Telegram-Bot-Api-Secret-Token│
│ 2. 解析 Update                       │
│ 3. D1 inbox 幂等登记(按状态)          │
│ 4. 同步执行业务:                     │
│    用户消息 → 复制进用户 Topic        │
│    管理员 Topic 消息 → 复制给用户      │
│    /ban /unban 管理命令               │
│ 5. 标记 processed                     │
│ 6. 返回 HTTP 200(失败返回 5xx 触发重试)│
└──────┬───────────────────┬───────────┘
       │                   │
       ▼                   ▼
┌──────────────┐   ┌─────────────────────┐
│ D1(唯一存储) │   │ Telegram Bot API    │
│ 用户/会话/    │   │ copyMessage 等      │
│ 消息/inbox    │   └──────────┬──────────┘
└──────────────┘              ▼
                    ┌─────────────────────┐
                    │ 私有 Forum 超级群    │
                    │ 每个用户一个 Topic   │
                    └─────────────────────┘
```

Phase 1 不用 Queue 的理由与代价:

- **理由**:免费额度即可运行;代码量最小;Telegram 对失败 Webhook 自带重试(递增退避),配合 inbox 状态机(见 [03](03-message-pipeline.md))已构成完整的重试闭环;
- **代价**:处理时长受 Webhook 请求生命周期限制;同一用户的多条消息在并发 Webhook 下可能乱序(低流量下罕见,Phase 4 用 Durable Objects 解决)。

## Bot 轴与群轴:从第一天解耦(架构约束)

Bot 与支持群是两根可独立替换的轴(总览「原理四」)。这一约束让换绑(换 Bot、换群)不必改业务代码,也为未来可能的无缝迁移留位——迁移功能本身已延后(见 [11](11-roadmap.md)「延后意向」),但数据形态从 Phase 1 起就按「两根独立轴」组织,写代码时就要守住:

```text
Bot 轴(谁在收) :webhook_key → bots 行(Token/Secret/群绑定)     ← env 引导(P1)/加密入库(P4)
群轴(送到哪)   :conversations.support_chat_id + message_thread_id ← 群坐标是会话数据,不是全局常量
业务数据(历史) :全部外键挂内部 bots.id / conversation_id          ← 不绑 Token、不绑特定群
```

- **数据不绑 Token**:customers / conversations / messages / audit_logs 只认内部 `bots.id`;换 Bot = 原地更新 bots 行,历史数据原封不动(换绑 Runbook 见 [05](05-webhook-management.md));
- **群不绑 Bot**:支持群坐标是 conversation 行的字段;群作为独立轴可单独替换(换群 = 更新绑定行 + 会话坐标重置,见 [02](02-forum-routing.md)、[05](05-webhook-management.md));
- **换绑 = 更新绑定行**:绑定状态(哪个 Bot 在营业、送到哪个群)统一落 D1,由管理动作显式变更并写审计;env 只承担引导(见 [05](05-webhook-management.md));无缝迁移(generation 代际、legacy_redirect)延后,立项时另行设计;
- **对 Phase 1 的具体要求**:① 群 id 一律从 conversation / bots 行取,不得引入「全局唯一群」的环境变量旁路;② webhook 路由按 `webhook_key` 定位 bot 行,为多 Bot 留位(见 [05](05-webhook-management.md) 多 Bot 架构);③ 无缝迁移 Phase 1 不实现(已延后,见 [11](11-roadmap.md)),但以上数据形态不锁死它。

## Phase 2 目标架构(可靠性)

```text
Webhook 请求(轻量化)                     异步处理
┌────────────────────────────┐    ┌──────────────────────────┐
│ Worker                      │    │ Queue Consumer           │
│ 1. 校验 Secret              │    │ 用户消息 → 用户 Topic     │
│ 2. inbox 幂等登记           │───>│ 管理员消息 → 用户私聊     │
│ 3. 入队 Queue,立即返回 200  │Queue│ /ban /unban              │
└────────────────────────────┘    │ outbox 发送 + 重试 + DLQ  │
       │                          └───────┬──────────┬───────┘
       ▼                                  ▼          ▼
┌──────────────────┐             ┌──────────┐  ┌──────────┐
│ D1               │             │ D1       │  │ Telegram │
└──────────────────┘             └──────────┘  └──────────┘
```

引入 Queue 后,Webhook 只做「登记 + 入队」,处理移到 Consumer,outbox 兜底外部调用。**处理函数与 Phase 1 完全复用**(同一份 pipeline 代码,只是触发方式从「Webhook 同步调用」变为「Queue 消费调用」),这是 Phase 1 把业务逻辑与触发入口解耦的原因。

## 组件职责

| 组件 | 阶段 | 职责 |
|------|------|------|
| Worker | P1 | Webhook 校验、幂等登记、业务处理、绑定/解绑管理端点、健康检查 |
| D1 | P1 | 唯一事实源:用户、会话、消息文本与索引、封禁状态、inbox、审计日志 |
| Queue + DLQ | P2 | Webhook 解耦、异步处理、消费重试 |
| outbox | P2 | Telegram 调用的发送幂等与重试兜底 |
| R2 | P3 | 图片/视频/文件附件、原始 Update 归档、压缩历史 |
| Durable Objects | P4 | 按 Topic 串行处理,消除并发乱序与状态竞争 |
| 迁移控制面 | P4(延后) | 双轴替换的协调:generation 代际、active 绑定指针、广播 outbox、legacy_redirect——已延后,立项时重新设计(见 [11](11-roadmap.md)) |
| 私有 Forum 超级群 | P1 | 仅 Bot + 管理员可见;`General` Topic 用于公告,不绑定用户 |

## Worker 内部模块划分(供任务拆分参考)

```text
src/
├── webhook/            # 入口:路由、Secret 校验、Update 解析
├── inbox/              # 幂等登记 + 状态机(03 的核心)
├── pipeline/           # 业务处理函数(入站/出站/命令分发)
│   ├── inbound/        #   用户消息 → Topic
│   ├── outbound/       #   管理员 Topic 消息 → 用户私聊(含 403 处理)
│   └── commands/       #   /ban /unban
├── domain/             # 用户/会话/Topic 服务(含 creating 窗口处理,02)
├── telegram/           # Bot API client:错误分类、429 退避(03)
├── store/              # D1 访问层(表结构见 06)
├── admin/              # 初始化/绑定/解绑端点(05)
└── migration/          # (P4 预留,已延后) 迁移协调:代际/active 绑定切换/广播 outbox/legacy_redirect
```

划分原则:**pipeline 不感知触发方式**(Webhook 同步或 Queue 消费),方便 Phase 2 平移;pipeline 同样**不感知绑定角色**——业务角色的分流在入口层完成,Phase 1 单 Bot 下入口层恒为 active。

## 平台选型结论

- Workers + D1 足以支撑 Phase 1;Workers Free 适合开发与极低流量,**生产建议 Paid Workers**;
- 各组件官方限制、Free/Paid 取舍与 D1 写入开销的细节以 [07](07-storage.md) 为单一来源,上线前复核。

## 一键部署设计约束(写代码时就要守住)

本项目要求支持 Cloudflare「Deploy to Cloudflare」按钮:使用者 fork 仓库 → 点击按钮 → 填一份表单(3 个 Secret + 2 项非敏感配置)→ 调一次空请求体 `/public/setwebhook` 完成绑定。为此,代码与仓库从第一天起遵守:

- **一切声明式**:Worker、D1 绑定、迁移文件全部定义在 `wrangler.jsonc` 与 `migrations/`,不依赖控制台手工建表或点选;
- **迁移幂等且进部署命令**:D1 迁移有台账、天然可重复执行;Deploy Button 会自动建库但**不会**跑迁移(官方已知缺口),部署命令必须前置 `npx wrangler d1 migrations apply DB --remote`;
- **无构建期 Secret**:所有 Secret 运行时从 `env` 读,构建产物不含敏感值,仓库保持可公开;
- **配置按敏感度分两类入栈**:敏感值(Bot Token、两个 Secret)进 Secret;支持群 ID 与管理员白名单属非敏感引导配置,进普通环境变量(`SUPPORT_CHAT_ID` / `ADMIN_IDS`)。`/public/setwebhook` 空请求体,配置全部取自环境变量;**env 是配置的唯一通道**——修改环境变量后重跑 setwebhook 即生效(白名单亦由 `ADMIN_IDS` 全量同步,见 [05](05-webhook-management.md));
- **自描述端点**:`/health` 部署完即可验活;`/public/setwebhook` 是唯一的首次引导入口。

按钮机制、`.dev.vars.example` 的 Secret 清单角色与部署命令配置的落地细节见 [05](05-webhook-management.md)。

---

下一篇:[02-forum-routing — 私有 Forum 与 Topic 路由](02-forum-routing.md)
