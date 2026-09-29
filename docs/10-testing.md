# 10 · 测试与验收

> **hodor 设计文档 · 10/12**
> 上一篇:[09-security-ops](09-security-ops.md) · 下一篇:[11-roadmap](11-roadmap.md) · [返回总览](README.md)

---

## 测试环境建议

- **单元/管线测试**:Vitest + `@cloudflare/vitest-pool-workers`(真实 workerd 运行时,本地 D1/miniflare,迁移由测试自动应用) + mock Telegram API(fetch 层打桩,覆盖 429/403/400/5xx 分类,见 [03](03-message-pipeline.md));
- **真机集成测试**:专用测试 Bot + 测试私有 Forum 群 + 两个测试账号(扮演用户 A/B)+ 一个测试管理员账号;绝不使用生产 Bot。

## 单元测试清单

**入口与鉴权**

- Secret 头正确 / 错误 / 缺失(401,无业务副作用);
- `webhook_key` 不匹配;
- `/health` 不泄露配置。

**幂等状态机(03)**

- 新 Update 正常登记并处理;
- 重复 `update_id` 且 `processed` → 跳过返回 200;
- 重复且 `pending`、attempts 未超限 → 重新执行;
- 重复且 attempts ≥ `MAX_ATTEMPTS` → 置 `failed` 返回 200;
- 处理失败 → 返回 5xx 且 attempts 递增;
- blocked 拒绝 → 标记 `processed`(不进重试);
- 400 永久错误 → 标记 `processed`(毒丸不重试)。

**路由与映射(02)**

- 用户 ↔ Topic 正确映射;用户 A/B 不串线;
- 首次联系创建 Topic;`creating` 状态的崩溃窗口路径(重试后标记消息 + 审计);
- 未知 `message_thread_id`、General Topic、非白名单成员 → 忽略;
- `allowed_updates` 之外的类型不投递(mock setWebhook 参数断言);
- `edited_message` 忽略;
- Update 字段全集与 Phase 1 实际解析范围以 [03](03-message-pipeline.md)「Update 结构速查」为准,判空与内容字段用例从其推导。

**中继(03)**

- 入站:copyMessage 参数正确(from=私聊,to=群 Topic);
- 出站:校验链(群 ID/thread/白名单/Bot 管理员缓存);
- 403 → `bot_blocked_by_user` 置位 + Topic 提示一次;用户回归 → 清除 + 恢复提示;
- 429 → `retry_after` 退避;超预算 → 走重试;
- 用户改名 → 标题刷新;标题超 128 字符截断。

**管理命令(04)**

- `/ban` `/unban` 白名单内可执行、外不可执行;
- 命令绝不进入 `copyMessage`;命令消息被删除;
- 标题图标与 `customers.blocked` 一致;`conversations.status` 不含 blocked;
- `CLOSE_TOPIC_ON_BAN` 关闭时 ban 后 Topic 仍可发消息(服务提示可达);
- 命令写审计日志;
- `/purge`:非白名单拒绝;confirm 序号不匹配 / 超时拒绝;执行顺序审计先行;conversation 与 messages 删除而 customer 保留;重复 confirm 幂等;
- `/risk` `/unrisk`:白名单内外;标题 `⚠️` 与 `customers.watchlisted` 一致;与封禁独立(可并存,unban 后 `⚠️` 恢复);置位提示一次;入站 WATCH_NOTICE 24h 限频(时间戳内不重复);
- `/deluser`:confirm 序号不匹配 / 超时拒绝;墓碑先于 customer 删除;messages/conversations/customer 全删而审计保留;非 `/start` 静默忽略;`/start` 重建新序号并继承 `was_watchlisted`;重复 confirm 幂等。

**数据层(06)**

- 迁移前后 Schema 兼容(Expand/Contract 规则);
- 唯一索引冲突行为(`INSERT OR IGNORE` + `meta.changes`)。

## 集成测试(真机)

```text
 1. 用户 A、B 同时发送消息
 2. 确认分别进入 Topic A、Topic B
 3. 管理员分别回复
 4. 确认回复回到正确用户
 5. 在 Topic A 执行 /ban
 6. 确认 A 后续消息被阻止且标题显示 🔇
 7. 确认 B 不受影响
 8. 在 Topic A 执行 /unban
 9. 确认 A 恢复且 🔇 消失
10. 重复发送同一 Update(重放 inbox payload)
11. 确认没有重复创建 Topic 或重复发送
12. 解绑/重绑和灰度更新期间确认不丢 Update
13. 用户 A 拉黑 Bot → 管理员回复 → Topic 出现「无法送达」提示(403 处理)
14. 用户 A 解除拉黑并再发消息 → 标志清除、回复恢复
15. 非白名单成员在支持群 Topic 发言 → 无任何中继
16. 制造 429(短时间大量发送)→ 消息退避后仍全部送达
17. 换绑演练:归档台账并绑定新 Bot 后,老用户发消息 → 进入原 Topic,历史连续
18. 换绑演练:新 Bot 的低位 update_id 正常处理,不被旧台账幂等命中
19. /purge 演练:确认执行后 Topic 整体删除、D1 无会话残留、General 出现公告、审计含 purge;该用户再发消息 → 新建 Topic 且序号不变
20. /risk 演练:标记后标题出现 ⚠️ 且收到置位提示;用户与管理员继续正常收发;再入站出现 WATCH_NOTICE(24h 内不重复);期间 /ban 后标题 🔇、/unban 后恢复 ⚠️;/unrisk 后 ⚠️ 消失
21. /deluser 演练:确认后 customer/conversations/messages 全删、Topic 删除、General 公告、审计含 deluser;该用户再发消息无响应;/start 后新序号恢复对话,高危标记按墓碑继承
```

## 第一版验收标准

- 每用户一个稳定 Topic;管理员无需回复具体原消息;
- `/ban`、`/unban` 只能管理员执行且用户收不到;
- Topic 标题状态与 D1 状态一致(单源:`customers.blocked`);
- 错误 Webhook Secret 被拒绝;
- 重复 Update 不重复执行;处理失败的消息可经重试或手工重放恢复,不静默丢失;
- 用户拉黑 Bot 后管理员得到明确提示,用户回归后自动恢复;
- 429 限流下消息退避送达,不丢失;
- 滚动更新不破坏数据库 Schema(灰度期间新旧版本共存);
- 文本与媒体长期可追溯:文本/索引在 D1,媒体 `media_file_id` 落库且可重发(R2 独立归档为 Phase 3 可选项);
- 审计日志覆盖绑定/解绑/白名单变更/封禁操作,不含敏感值。

---

下一篇:[11-roadmap — 实施路线图](11-roadmap.md)
