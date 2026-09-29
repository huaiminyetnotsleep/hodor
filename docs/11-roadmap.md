# 11 · 实施路线图

> **hodor 设计文档 · 11/13**
> 上一篇:[10-testing](10-testing.md) · 下一篇:[12-references](12-references.md) · [返回总览](README.md)

---

## 阶段总览

| 阶段 | 主题 | 核心内容 | 主要依据 |
|------|------|----------|----------|
| **Phase 1** | MVP | Worker + D1 同步处理:Webhook、私有 Forum 路由、管理员回复、`/ban`/`/unban`、标题图标、绑定/解绑、幂等状态机 | 01–06 |
| **Phase 2** | 可靠性 | Queue、outbox、DLQ、Cloudflare Access、Topic 创建失败恢复、灰度发布 | 07、08 |
| **Phase 3** | 独立归档(可选) | 可选 R2 归档(附件原件/老化 Update)、D1 历史迁移、容量监控、导出与恢复 | 07、09 |
| **Phase 4** | 扩展 | per-Topic Durable Objects、多管理员分配、多 Bot、Web 管理台、用户标签与统计、/start 用户验证(见 09) | 07、08 |

## Phase 1 功能 ↔ 文档映射(立任务时按行领取)

| 功能 | 依据文档 | 备注 |
|------|----------|------|
| 工程脚手架(wrangler/TS/目录) | [01](01-architecture.md) | 模块划分即目录结构 |
| D1 迁移与 seed | [06](06-data-model.md) | outbox 不建 |
| Telegram client(错误分类/429 退避) | [03](03-message-pipeline.md) | 供全管线复用 |
| Webhook 骨架 + Secret 校验 + /health | [03](03-message-pipeline.md)、[05](05-webhook-management.md)、[09](09-security-ops.md) | |
| inbox 幂等状态机 | [03](03-message-pipeline.md)、[08](08-reliability.md) | 核心先行 |
| 用户/会话/Topic 服务 | [02](02-forum-routing.md) | 含崩溃窗口预案 |
| 入站中继 | [03](03-message-pipeline.md) | |
| 出站中继 + 403 处理 | [03](03-message-pipeline.md) | |
| `/ban` `/unban` | [04](04-admin-commands.md) | |
| `/purgemsg` 清理用户全部消息 | [04](04-admin-commands.md) | 含无状态二次确认、审计先行与崩溃预案 |
| `/risk` `/unrisk` 高危名单 | [04](04-admin-commands.md) | 标题 ⚠️ 与 24h 限频提示;可与封禁叠加 |
| `/deluser` 删除用户 | [04](04-admin-commands.md) | 墓碑门禁;/start 重新开启,继承高危标记 |
| 绑定/解绑端点与白名单同步(setwebhook / deletewebhook) | [05](05-webhook-management.md) | 不做管理 UI,配套运维脚本,见 05 运维方式决策 |
| 只读运维脚本(db-customers / db-conversations / db-messages / db-inbox-failed) | [09](09-security-ops.md) | 随脚手架落地,Secret 走环境变量;管理端操作不封装脚本,直接调管理端点(见 05) |
| 一键部署(Deploy Button:wrangler.jsonc 声明式资源、`.dev.vars.example`、部署命令含 D1 迁移) | [01](01-architecture.md)、[05](05-webhook-management.md) | 随脚手架落地;首次引导流程见 05 |
| 审计日志 | [06](06-data-model.md)、[09](09-security-ops.md) | |
| 单元/集成测试 | [10](10-testing.md) | 随功能同步写 |
| 部署演练与验收 | [09](09-security-ops.md)、[10](10-testing.md) | 真机测试用测试 Bot |

## 建议实施顺序(依赖驱动)

```text
① 脚手架 + D1 迁移           (一切的地基)
② Telegram client + mock     (可测性的前提)
③ Webhook 骨架 + Secret 校验  (入口打通,可 401 演示)
④ inbox 幂等状态机            (核心,先于一切业务)
⑤ 用户/会话/Topic 服务        (依赖 ④ 的处理框架)
⑥ 入站中继                    (依赖 ⑤)
⑦ 出站中继 + 403 处理         (依赖 ⑤)
⑧ /ban /unban + 标题渲染      (依赖 ⑤⑦)
⑨ 初始化/绑定端点 + 白名单     (可与 ⑥⑦⑧ 并行)
⑩ 审计日志接入                 (横切,随 ⑧⑨ 落地)
⑪ 测试补全 + 真机集成演练      (10 的清单)
⑫ 部署前检查单过一遍           (09 的清单)
```

每一步都是一个天然的 Trellis 任务粒度:输入 = 对应文档,输出 = 代码 + 测试。执行视角的增量步骤、依赖关系与每步的功能完整性验收线(含当前状态)见 [13](13-implementation-steps.md)。

原记录于 TODO 的功能意向已并入各篇功能设计(用户验证见 [09](09-security-ops.md),`/help` 等命令见 [04](04-admin-commands.md),信息卡与欢迎语见 [02](02-forum-routing.md)/[03](03-message-pipeline.md)),按 [13](13-implementation-steps.md) 的步骤排期。

## 延后意向

| 意向 | 说明 | 立项要求 |
|------|------|----------|
| 群/Bot 无缝迁移 | 换群/换 Bot 的零丢失连续性:逐会话 Topic 迁移、migration_token、广播 outbox、legacy_redirect、generation 代际控制面。原设计契约(原 docs/13)已于 2026-09-29 删除 | 立项时**重新设计**(绑定模型、一致性边界、回滚语义均需重新评审),另立设计文档与任务,不沿用已删除文档的结论 |

## 阶段间承诺

- Phase 1 的 pipeline 代码在 Phase 2 换触发方式(Queue)时**不重写**(见 [08](08-reliability.md) 平移预告);
- Phase 4 引入 DO 前,乱序与创建竞争是已知且接受的限制(见 [03](03-message-pipeline.md)、[02](02-forum-routing.md));
- 每阶段开始前复核 [07](07-storage.md) 的官方限制是否有变化。

---

下一篇:[12-references — 参考资源](12-references.md)
