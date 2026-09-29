# 13 · 从 0 到 1 实施步骤

> **hodor 设计文档 · 13/13**
> 上一篇:[12-references](12-references.md) · [返回总览](README.md)

本文把 PRD 与 [01–12](README.md) 的设计切成**可独立交付的增量**:整个项目不可能一次建成,先从基础功能做起,再不断丰富。[11](11-roadmap.md) 给出阶段规划(Phase 1–4)与功能↔文档映射;本文给出执行视角的步骤顺序、依赖关系,以及**每一步的功能完整性验收线**。

---

## 增量交付原则

1. **每步结束时系统完整可用**:能部署、能验活,已交付的功能端到端可用——不做「半成品长在主干上」;
2. **先地基后业务**:鉴权(Secret)与幂等(inbox)先于一切业务功能,后续所有步骤都构建在它们之上;
3. **测试随步走**:[10](10-testing.md) 的测试清单按步骤领取,每步交付代码 + 测试,验收线全绿才进入下一步;
4. **已知限制显式记录**:Topic 创建崩溃窗口([02](02-forum-routing.md))、并发乱序([03](03-message-pipeline.md))等在对应 Phase 消除,不阻塞早期交付;
5. **架构解耦约束从第一天守住**:「Bot 轴与群轴解耦」([01](01-architecture.md))在 Phase 1 就落实为代码纪律(数据不绑 Token/群、按 `webhook_key` 定位 bot 行),为未来的换绑与多 Bot 能力留位;
6. **状态只进不退**:某步验收线破坏时回修该步,不带病进入下一步。

---

## 里程碑总览

| 里程碑 | 含义 | 达成标志 |
|--------|------|----------|
| M0 | 地基 | 可部署的空 Worker + D1 Schema + 打桩可测的 Telegram client + 鉴权与幂等 |
| M1 | 单向可达 | 用户私聊消息端到端落入自己的 Topic |
| M2 | 双向客服 | 管理员在 Topic 回复,用户私聊收到 |
| M3 | 可封禁 | `/ban` `/unban` + 标题 🔇,命令用户不可见 |
| M4 | 管理命令全集 | 六条命令全部可用(`/purgemsg` `/risk` `/unrisk` `/deluser`) |
| M5 | 可绑定可运维 | setwebhook/deletewebhook 端点 + 审计 + 只读脚本,非开发者可完成绑定 |
| M6 | Phase 1 MVP v1.0 | 测试全集全绿,真机部署演练通过 |
| M7 | 部署体验闭环 | fork 使用者零代码改动完成部署与绑定 |
| P2/P3/P4 | 可靠性 / 归档 / 扩展 | Queue、R2、DO、验证体系、多 Bot |

---

## 步骤表

状态说明:✅ 已完成 · 🔄 进行中 · ⬜ 未开始(截至 2026-09-29)。

| 步骤 | 功能 | 主要交付物 | 依赖 | 功能完整性保证(本步验收线) | 里程碑 | 状态 |
|------|------|-----------|------|------------------------------|--------|------|
| 0 | 仓库与资源置备 | `wrangler.jsonc` 声明式配置、D1 建库、Node 工具链 | — | `wrangler deploy` 成功,`GET /health` 返回 200 | M0 | ✅ |
| 1 | D1 Schema 与迁移 | `0001_init.sql`:bots / customers / deleted_users / conversations / support_admins / inbox_updates / messages / audit_logs + 索引([06](06-data-model.md)) | 0 | 迁移幂等可重放;Schema 测试通过;状态值与 06 字典一致 | M0 | ✅ |
| 2 | Telegram Bot API client | 错误分类(429/403/400/5xx)、`retry_after` 退避、`getChatMember` 缓存([03](03-message-pipeline.md)) | 0 | 打桩测试覆盖全部错误分类与退避路径 | M0 | ✅ |
| 3 | Webhook 入口与鉴权 | `/telegram/webhook/:key` 路由、Secret 头 SHA-256 校验、`/health`([03](03-message-pipeline.md)、[05](05-webhook-management.md)) | 0,2 | 错误/缺失 Secret → 401 且无业务副作用、无业务日志 | M0 | ✅ |
| 4 | inbox 幂等状态机 | 按「处理状态」登记/跳过/重试/failed,`MAX_ATTEMPTS` 上限([03](03-message-pipeline.md)) | 1,3 | 状态机全分支测试:重复投递不重复执行、失败可重试不吞消息、超限进 failed 返回 200 | M0 | ✅ |
| 5 | 用户/会话/Topic 服务 | customer 查建、墓碑门禁、`creating` 崩溃窗口预案、标题渲染([02](02-forum-routing.md)、[04](04-admin-commands.md)) | 4 | 映射唯一索引生效;标题与 D1 状态一致;崩溃窗口重试路径有标记消息 + 审计 | M0 | ✅ |
| 6 | 入站中继(用户 → Topic) | 用户消息 copyMessage 进 Topic,blocked/忽略策略([03](03-message-pipeline.md)) | 5 | 用户 A/B 不串线;blocked 静默丢弃;General/未知 thread/非白名单全部忽略 | **M1** | ✅ |
| 7 | 出站中继(管理员 → 用户)+ 403 | 校验链(群 ID/thread/白名单)、拉黑置位与恢复提示([03](03-message-pipeline.md)) | 6 | 白名单外不中继;403 置位提示一次、用户回归自动恢复 | **M2** | ✅ |
| 8 | `/ban` `/unban` + 标题图标 | 应用层封禁、标题重渲染、命令删除、审计([04](04-admin-commands.md)) | 7 | 命令绝不进 copyMessage;标题与 `customers.blocked` 单源一致;白名单外不可执行 | **M3** | ✅ |
| 9 | `/purgemsg` `/risk` `/unrisk` `/deluser` | 清理用户全部消息(二次确认)、高危名单(⚠️ + 24h 限频)、删除用户(墓碑)([04](04-admin-commands.md)) | 8 | 确认序号/超时/幂等按 04 验收;墓碑先于删除;审计先行;高危与封禁可叠加 | **M4** | ✅(实现中命令名仍为 /purge,重命名待办见 04 命名注) |
| 10 | 绑定/解绑端点与白名单 | `/public/setwebhook`、`/public/deletewebhook`,白名单 env 全量同步,setMyCommands([05](05-webhook-management.md)) | 5 | setwebhook 空请求体从 env 引导;白名单同步落审计;绑定后真机收发验证通过 | **M5** | ✅(实现中仍为 /admin/setup 等,收敛见 05 命名注) |
| 11 | 审计与只读运维脚本 | audit_logs 全接入、`scripts/d1-console.sql`([06](06-data-model.md)、[09](09-security-ops.md)) | 8,10 | 全部变更操作落审计且不含敏感值;常用查询固化可执行 | M5 | ✅ |
| 12 | 测试全集与部署演练 | 自动化测试全集、真机回归清单([10](10-testing.md)) | 全部 | 10 的第一版验收标准全绿;测试 Bot 真机演练通过 | **M6** | ✅(人工回归 V4–V10 分期进行) |
| 13 | 零命令自动绑定 | 绑定无参化、provision/deploy 脚本、Deploy Button 引导([01](01-architecture.md)、[05](05-webhook-management.md)) | 12 | fork 使用者零代码改动完成「部署 → 配置 → 绑定」全流程 | **M7** | ⬜(前次方案已撤销,绑定架构重设计中) |
| 14 | Queue + outbox + DLQ | Webhook 登记入队、Consumer 复用同一 pipeline、outbox 发送幂等([01](01-architecture.md)、[08](08-reliability.md)、[06](06-data-model.md)) | 12 | pipeline 代码不改写(只换触发方式);重复/失败语义与 Phase 1 等价;DLQ 巡检闭环 | P2 | ⬜ |
| 15 | 发布硬化 | Cloudflare Access、灰度发布实操、容量监控([08](08-reliability.md)、[09](09-security-ops.md)) | 14 | 滚动发布 + 回滚演练通过;监控项全部有数据源 | P2 | ⬜ |
| 16 | R2 归档与容量治理 | 附件原件/老化 Update 落桶,`/purgemsg` `/deluser` 连带删 R2,定期导出([07](07-storage.md)、[09](09-security-ops.md)) | 12 | 三级存储边界验收;Time Travel + 导出恢复演练通过 | P3(可选) | ⬜ |
| 17 | per-Topic Durable Objects | 按 `bot_id + support_chat_id + message_thread_id` 分片串行([07](07-storage.md)、[08](08-reliability.md)) | 12 | [03](03-message-pipeline.md) 并发乱序限制消除;Topic 创建竞争加串行保护 | P4 | ⬜ |
| 18 | 人机验证体系 | `/verifyon` `/verifyoff` 开关、按钮验证 / 数学题 / TGuard(Mini App) 三方式、`MAX_MESSAGES_PER_MINUTE` 超限重验(设计见 [09](09-security-ops.md)「人机验证与频率限制」、[04](04-admin-commands.md) Phase 4 命令节) | 12 | 验证通过前不建户不建 Topic;结果防重放;关闭开关可跳过;超限触发重验 | P4 | ⬜ |
| 19 | 客服体验增强 | `/help` 命令、Topic 置顶用户信息卡片(用户名/ID/首次联系时间)、欢迎语含项目信息(设计见 [04](04-admin-commands.md)、[02](02-forum-routing.md)、[03](03-message-pipeline.md)) | 12 | PRD 对应条目逐条验收;欢迎语与置顶信息不泄露管理端信息 | P4 | ⬜ |
| 20 | 多 Bot 架构 | `encrypted_bot_token` 主密钥加密、多 Bot 路由([05](05-webhook-management.md)) | 14 | 多 Bot 幂等命名空间隔离(update_id 按 Bot 独立);绑定/解绑互不干扰 | P4 | ⬜ |
| 21 | 群/Bot 无缝迁移 | migration_token、广播 outbox、legacy_redirect、generation 代际 | 20 | 立项时重新设计并另立设计文档(已延后,见 [11](11-roadmap.md)「延后意向」) | P4 | ⬜ 延后 |
| 22 | Web 管理台(条件触发) | 触发条件见 [05](05-webhook-management.md)(多 Bot 常态化/非技术人员接管等) | 20 | 立项时另评 | P4 | ⬜ |

---

## 与 PRD 的对照

- 步骤 0–13 覆盖 PRD 的**基础功能**:双向客服、多管理员、六条管理命令、绑定/换绑、自部署;
- 步骤 18–19 对应 PRD「功能设计」中的人机验证、频率限制、`/help`、置顶用户信息、欢迎语;
- 步骤 20 对应 PRD 的多 Bot 意向;迁移/广播意向已延后(见 [11](11-roadmap.md)「延后意向」);
- PRD 中与设计决策有出入的意向(Token 入 URL、R2 作主存等)的裁决记录见总览「[PRD 意向与设计决策的出入](README.md#prd-意向与设计决策的出入透明记录)」。

## 与 Trellis 任务的衔接

- 每一步 ≈ 一个 Trellis 任务粒度:输入 = 对应设计文档,输出 = 代码 + 测试,验收线 = 本表「功能完整性保证」列;
- 功能意向已并入各篇设计(步骤 18 → [09](09-security-ops.md) / [04](04-admin-commands.md);步骤 19 → [04](04-admin-commands.md) / [02](02-forum-routing.md) / [03](03-message-pipeline.md);步骤 20 → [05](05-webhook-management.md)),进入对应步骤时展开为任务;
- 已完成的 S1–S10 任务见 `.trellis/tasks/`;步骤 13(零命令自动绑定)的前次任务已撤销,待绑定架构重设计后重新立项。
