# 07 · 存储策略与平台限制

> **hodor 设计文档 · 07/12**
> 上一篇:[06-data-model](06-data-model.md) · 下一篇:[08-reliability](08-reliability.md) · [返回总览](README.md)

---

## 各存储的职责边界

```text
D1(P1)  —— 唯一事实源:用户、会话、状态、短文本、索引、inbox、审计
R2(P3)  —— 大对象:附件、原始 Update 归档、压缩历史
KV(P1+) —— 只读缓存:配置、文案模板、短 TTL
Queue(P2)—— 异步解耦与重试
DO(P4)  —— per-Topic 串行化
```

## D1

保存用户、Topic、状态、短文本、消息索引、inbox、审计日志。

容量要点(上线前以官方页面复核,链接见 [12](12-references.md)):

- Free 单库约 500 MB;Paid 单库约 10 GB;
- 单字符串 / BLOB / 完整行约 2 MB——inbox 的 `payload_json` 一般远小于此,异常大的 Update 才需要外移;
- 写入串行,写入过多会排队——Phase 1 每个 Update 约 2–4 次写入,无虞;Phase 2 起关注批量归档的写放大。

**永久保留 ≠ 单库无限增长**:接近阈值时把旧正文与附件归档到 R2,D1 保留摘要、索引和 R2 key(Phase 3,见 [11](11-roadmap.md))。

备份:使用 D1 Time Travel(默认保留 30 天)作为误操作恢复手段,定期导出基数数据(见 [09](09-security-ops.md))。

## R2(Phase 3)

保存:

- 图片、视频、文件附件;
- 原始 Telegram Update(inbox 老化后外移);
- 压缩历史归档。

D1 侧保留 `file_id`、文件类型、大小、`r2_object_key` 与消息的关联(见 [06](06-data-model.md) 的 `messages` 表)。

## KV —— 明确的「不用于」清单

KV 最终一致,读不到刚写的值,因此**不得用于**:

- Webhook 去重(inbox_updates 才是,见 [03](03-message-pipeline.md));
- 封禁状态事实源(`customers.blocked` 才是,见 [04](04-admin-commands.md));
- Topic 映射主数据(conversations 表才是,见 [02](02-forum-routing.md));
- 分布式锁。

**允许用于**:配置缓存、文案模板、短 TTL 缓存(如 `getChatMember` 结果的跨实例缓存,见 [03](03-message-pipeline.md))。

## Queue(Phase 2)

- 单条消息约 128 KB(超限的 Update 走 R2 引用);
- 至少一次投递,必须配合 D1 唯一索引幂等(与 Webhook 重复投递共用同一套 inbox 状态机);
- DLQ 策略见 [08](08-reliability.md)。

## Durable Objects(Phase 4)

分片键:

```text
bot_id + support_chat_id + message_thread_id
```

用于同一 Topic 的串行处理(消除乱序与创建竞争,见 [03](03-message-pipeline.md) 已知限制)。**不要**把所有用户放进一个全局 DO。

## 计划选择

- Workers Free:开发与极低流量(Free CPU 约 10ms;Phase 1 同步处理下,校验 + D1 + 加密 + 外部调用叠加后余量小);
- **生产建议 Paid Workers**;D1/R2/Queue 按用量计费,Phase 1 用量远低于付费门槛,以限制页为准。

---

下一篇:[08-reliability — 可靠性与发布](08-reliability.md)
