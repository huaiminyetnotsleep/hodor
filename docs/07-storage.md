# 07 · 存储策略与平台限制

> **hodor 设计文档 · 07/13**
> 上一篇:[06-data-model](06-data-model.md) · 下一篇:[08-reliability](08-reliability.md) · [返回总览](README.md)

---

## 各存储的职责边界

```text
D1(P1)       —— 唯一事实源:用户、会话、状态、短文本、索引、inbox、审计
Telegram(P1) —— 媒体默认主存:媒体随 Topic 留在 Telegram,file_id 可重发(见下)
R2(P3 可选)  —— 独立归档:附件原件、原始 Update、压缩历史
KV(P1+)      —— 只读缓存:配置、文案模板、短 TTL
Queue(P2)    —— 异步解耦与重试
DO(P4)       —— per-Topic 串行化
```

## D1

保存用户、Topic、状态、短文本、消息索引、inbox、审计日志。

容量要点(上线前以官方页面复核,链接见 [12](12-references.md)):

- Free 单库约 500 MB;Paid 单库约 10 GB;
- 单字符串 / BLOB / 完整行约 2 MB——inbox 的 `payload_json` 一般远小于此,异常大的 Update 才需要外移;
- 写入串行,写入过多会排队——Phase 1 每个 Update 约 2–4 次写入,无虞;Phase 2 起关注批量归档的写放大。

**永久保留 ≠ 单库无限增长**:接近阈值时把旧正文与附件归档到 R2,D1 保留摘要、索引和 R2 key(Phase 3,见 [11](11-roadmap.md))。

备份与恢复的手段与节奏(Time Travel、定期导出)单一来源见 [09](09-security-ops.md)。

## 媒体与长期归档:三级存储

| 层 | 载体 | 内容 | 阶段 |
|----|------|------|------|
| T0 | Telegram 原生存储 | 媒体本体:用户发来的图片/视频/文件经 `copyMessage` 随消息存于支持群 Topic;Bot 持有的 `media_file_id` 可随时重发(源消息被删也不受影响) | P1 默认,零成本 |
| T1 | D1 | 元数据与索引:`content_type`、`media_file_id`、`r2_object_key`(见 [06](06-data-model.md) `messages` 表) | P1 |
| T2 | R2 | 独立归档:附件原件、老化 Update、压缩历史 | P3 **可选** |

**T0 就是默认方案,不引入 R2 也是完整系统**:Telegram 自身保存全部媒体,`file_id` 是指向该文件的长效句柄——官方未承诺永久有效,实践中长期稳定;边界:仅对获取它的同一个 Bot 有效,`getFile` 的下载链接仅约 1 小时有效且有 20 MB 限制(重发走 `file_id` 不受此限)。跨 Bot 换绑后旧 `file_id` 全部失效,但媒体本体仍在群内——按 `messages` 的群内副本坐标 `(target_chat_id, target_message_id)` 用 `copyMessage` 即可重放(见 [05](05-webhook-management.md) 换绑手册)。

R2 的定位是**可选的独立归档层**,不是媒体主存。触发条件是需要「群外自持副本」:防支持群被删导致 Telegram 侧副本消失、合规导出、D1 容量治理。启用时(Phase 3)经 `getFile` 下载附件原件(超 20 MB 需本地 Bot API server)与老化 Update 落桶,D1 保留 `r2_object_key` 指针(见 [06](06-data-model.md) 的 `messages` 表)。

## KV —— 明确的「不用于」清单

KV 最终一致,读不到刚写的值,因此**不得用于**:

- Webhook 去重(inbox_updates 才是,见 [03](03-message-pipeline.md));
- 封禁状态事实源(`customers.blocked` 才是,见 [04](04-admin-commands.md));
- Topic 映射主数据(conversations 表才是,见 [02](02-forum-routing.md));
- 分布式锁。

**允许用于**:配置缓存、文案模板、短 TTL 缓存(如 `getChatMember` 结果缓存——Phase 1 用 Worker 内存即可,见 [02](02-forum-routing.md);跨实例共享属 Phase 2+)。

## Queue(Phase 2)

- 单条消息约 128 KB(超限的 Update 走 R2 引用);
- 至少一次投递,必须配合 D1 唯一索引幂等(与 Webhook 重复投递共用同一套 inbox 状态机);
- DLQ 策略见 [08](08-reliability.md)。

## Durable Objects(Phase 4)

分片键:

```text
bot_id + support_chat_id + message_thread_id
```

用于同一 Topic 的串行处理,消除消息乱序([03](03-message-pipeline.md))与 Topic 创建竞争([02](02-forum-routing.md))。**不要**把所有用户放进一个全局 DO。

## 计划选择

- Workers Free:开发与极低流量(Free CPU 约 10ms;Phase 1 同步处理下,校验 + D1 + 加密 + 外部调用叠加后余量小);
- **生产建议 Paid Workers**;D1/R2/Queue 按用量计费,Phase 1 用量远低于付费门槛,以限制页为准。

---

下一篇:[08-reliability — 可靠性与发布](08-reliability.md)
