# 04 · 管理命令与封禁

> **hodor 设计文档 · 04/12**
> 上一篇:[03-message-pipeline](03-message-pipeline.md) · 下一篇:[05-webhook-management](05-webhook-management.md) · [返回总览](README.md)

---

## 命令优先级

命令在普通中继逻辑之前解析(见 [03](03-message-pipeline.md) 处理顺序):

```text
收到管理员 Topic 消息
        │
        ▼
是否为 /ban 或 /unban?
   ┌────┴────┐
   │         │
  是        否
   │         │
   ▼         ▼
执行管理   普通消息
操作并结束  copyMessage 给用户
```

`/ban`、`/unban` **绝不进入 `copyMessage`**,用户侧完全不可见(命令消息本身随后删除)。

## `/ban` 流程

1. 校验发送者在 `support_admins` 白名单(表见 [06](06-data-model.md));
2. 校验消息来自 `support_chat_id` 且 `message_thread_id` 有 conversation 映射(General/未知 thread → 忽略);
3. 按 thread 找到 conversation 与 customer;
4. **`customers.blocked = true`(唯一事实源写入,见「状态唯一来源」)**;
5. `editForumTopic`:重渲染标题为 `🔇 {name} · #{序号}`(规则见 [02](02-forum-routing.md));
6. **可选**(`CLOSE_TOPIC_ON_BAN`,默认 **关**):`closeForumTopic`。注意:Bot 能否向 closed Topic 继续发送需实测验证——若验证不通过则永久移除该选项;默认关闭的另一原因是封禁期间管理员可能仍需在 Topic 内留言存档;
7. `deleteMessage` 删除 `/ban` 命令消息;
8. 可选:向用户发送一次 `BANNED_NOTICE`(默认关,见 [03](03-message-pipeline.md) 文案模板);
9. 写 `audit_logs`(action = `ban`,记录 admin id 与 customer id,**不记录消息内容**);
10. 标记 Update 为 processed,结束处理。

## `/unban` 流程

1. 前三步校验同 `/ban`;
2. `customers.blocked = false`;
3. `editForumTopic` 重渲染标题为 `👤 {name} · #{序号}`(从数据库状态渲染,与旧标题无关);
4. 若该 Topic 曾被 close(查 `conversations.status = 'closed'`),`reopenForumTopic`;
5. `deleteMessage` 删除 `/unban` 命令消息;
6. 写 `audit_logs`(action = `unban`);标记 processed。

## 封禁语义:应用层封禁

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
转发 Topic  静默丢弃(默认)/可选提示
```

- 用户**不加入**管理群,因此无需 `restrictChatMember` 等 Telegram 群封禁;
- 封禁只影响「用户 → Topic」方向;管理员在 Topic 内的留言不受影响(存档价值);
- 解封后用户下一条消息恢复正常中继,无需任何额外操作。

## 状态唯一来源(M 级修订:消除双源漂移)

| 状态 | 唯一来源 | 语义 | 派生表现 |
|------|----------|------|----------|
| 封禁 | `customers.blocked` | 应用层封禁 | Topic 标题 `🔇`,入站静默丢弃 |
| Topic 生命周期 | `conversations.status` | `creating / open / closed / archived` | 是否允许中继、是否需 reopen |

**禁止**在 `conversations.status` 里再存一个 `blocked` 值——两处同时写必然漂移。标题图标是 `customers.blocked` 的纯派生展示,渲染规则见 [02](02-forum-routing.md)。

## 相关验收

命令的测试与验收条目见 [10](10-testing.md)(命令不进 copyMessage、白名单外不可执行、标题与 D1 状态一致等)。

---

下一篇:[05-webhook-management — Webhook 管理与初始化](05-webhook-management.md)
