# 11 · 实施路线图

> **hodor 设计文档 · 11/12**
> 上一篇:[10-testing](10-testing.md) · 下一篇:[12-references](12-references.md) · [返回总览](README.md)

---

## 阶段总览

| 阶段 | 主题 | 核心内容 | 主要依据 |
|------|------|----------|----------|
| **Phase 1** | MVP | Worker + D1 同步处理:Webhook、私有 Forum 路由、管理员回复、`/ban`/`/unban`、标题图标、绑定/解绑、幂等状态机 | 01–06 |
| **Phase 2** | 可靠性 | Queue、outbox、DLQ、Cloudflare Access、Topic 创建失败恢复、灰度发布 | 07、08 |
| **Phase 3** | 永久归档 | R2 附件、原始 Update 归档、D1 历史迁移、容量监控、导出与恢复 | 07、09 |
| **Phase 4** | 扩展 | per-Topic Durable Objects、多管理员分配、多 Bot、Web 管理台、用户标签与统计 | 07、08 |

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
| 初始化/绑定/白名单管理端点 | [05](05-webhook-management.md) | |
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

每一步都是一个天然的 Trellis 任务粒度:输入 = 对应文档,输出 = 代码 + 测试。

## 阶段间承诺

- Phase 1 的 pipeline 代码在 Phase 2 换触发方式(Queue)时**不重写**(见 [08](08-reliability.md) 平移预告);
- Phase 4 引入 DO 前,乱序与创建竞争是已知且接受的限制(见 [03](03-message-pipeline.md)、[02](02-forum-routing.md));
- 每阶段开始前复核 [07](07-storage.md) 的官方限制是否有变化。

---

下一篇:[12-references — 参考资源](12-references.md)
