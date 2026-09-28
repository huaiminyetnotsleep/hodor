# 08 · 可靠性与发布

> **hodor 设计文档 · 08/12**
> 上一篇:[07-storage](07-storage.md) · 下一篇:[09-security-ops](09-security-ops.md) · [返回总览](README.md)

---

## 投递语义:至少一次 + 幂等,不承诺 exactly-once

- Telegram Webhook 与(Phase 2 的)Queue 均为**至少一次**投递,重复靠 `inbox_updates` 状态机吸收(见 [03](03-message-pipeline.md));
- 对 Telegram 的外部发送没有通用幂等键,存在「发送成功后 Worker 崩溃 → 重试 → 重复发送」的窗口。**系统目标是把重复概率压到极低,不承诺严格 exactly-once**——这也是总览「非目标」中的明确声明。

## 重试闭环(Phase 1)

```text
处理失败
   │
   ▼
返回 5xx ──> Telegram 按递增退避重投同一 update_id
   │
   ▼
幂等命中(status=pending,attempts<8)→ 重新执行
   │
   ├── 成功 → processed
   │
   └── attempts ≥ MAX_ATTEMPTS(8)→ status=failed,返回 200 停止重投
                                      │
                                      ▼
                              Phase 1 手工 DLQ:
                              · 每日巡检 inbox_updates WHERE status='failed'
                              · 按 last_error 分类:临时故障 → 修正后置回 pending 重放;
                                永久故障 → 记录并 processed 归档
                              · 重放工具(P1 可用 wrangler d1 execute 手工 UPDATE)
```

注意毒丸规则:**重试只用于可重试错误**;400 类永久错误与 blocked 拒绝都直接 processed(见 [03](03-message-pipeline.md) 错误分类),不进重试。

## Topic 创建崩溃窗口(运维侧)

崩溃窗口的成因与处置预案单一来源见 [02](02-forum-routing.md)。运维侧要点:Bot API 无列举 Topic 的接口,无法自动对账,**监控 `topic_creation_retry` 审计事件是唯一发现途径**(告警项见 [09](09-security-ops.md));发现重复 Topic 后按 02 的人工合并步骤处理。

## 乱序(已知限制,Phase 4 消除)

同一用户并发 Webhook 可能使 Topic 内消息乱序(详细说明见 [03](03-message-pipeline.md)),客服场景可接受;Phase 4 引入 per-Topic DO(分片键见 [07](07-storage.md))后消除。

## 滚动发布

Webhook URL 保持稳定,发布新版本**不重设 Webhook**:

```text
旧版本 100%
    │
    ▼
部署新版本并进行 Smoke Test
    │
    ▼
1% 灰度 ──> 10% ──> 50% ──> 100% 全量
    │
    └── 任一阶段异常 → 立即回滚 Worker 版本(不回滚数据库)
```

灰度期间新旧版本可能同时处理 Update,必须共用**兼容 Schema 和状态值**(状态字典见 [06](06-data-model.md))。

一键部署路径的日常更新由 Workers Builds 在 push 时自动执行(部署命令含幂等的 D1 迁移,见 [05](05-webhook-management.md)),默认全量生效;需要灰度时改用 Versions 的 gradual deployments 手动控制。回滚语义不变:回滚 Worker、不回滚数据库。

## D1 迁移:Expand / Contract

```text
新增表/列/索引(只增不删)
    ↓
新旧代码都能运行
    ↓
部署新代码并回填
    ↓
确认旧版本不再接收流量(灰度 100% 且稳定)
    ↓
删除旧列/旧逻辑(单独一次迁移)
```

硬规则:

- **禁止**先删除旧列再部署依赖新列的代码;
- 回滚 Worker 版本时**不回滚**数据库迁移(所以迁移必须向后兼容);
- 状态值只增不改义(如未来废弃 `closed`,保留枚举值新增后继值)。

## 关键持久化规则

- 关键写入(幂等登记、messages、状态变更)必须在**返回响应之前**完成;
- **不得依赖 `waitUntil`** 承担任何关键路径持久化;
- Phase 1 同步处理下,返回 200 即代表「已处理完成」,这正是幂等状态机成立的前提。

## Phase 1 → Phase 2 平移预告

```text
Phase 1:Webhook ──同步──> pipeline ──> D1/Telegram
Phase 2:Webhook ──登记+入队──> Queue ──消费──> 同一 pipeline ──> D1/Telegram + outbox
```

pipeline 代码不变(见 [01](01-architecture.md) 模块划分),变化的只有触发入口;outbox 建表按 Expand/Contract 加入。因此 Phase 1 实现时,pipeline 不得引用 Webhook 专属上下文(如请求对象)。

---

下一篇:[09-security-ops — 安全与运维](09-security-ops.md)
