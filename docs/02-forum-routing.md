# 02 · 私有 Forum 群与 Topic 路由

> **hodor 设计文档 · 02/12**
> 上一篇:[01-architecture](01-architecture.md) · 下一篇:[03-message-pipeline](03-message-pipeline.md) · [返回总览](README.md)

---

## 支持群配置

```text
类型:Private Supergroup
Forum Topics:开启
成员:Bot + 管理员/客服
用户:不加入支持群,只和 Bot 私聊
```

Telegram API 中表现为:

```json
{ "type": "supergroup", "is_forum": true }
```

支持群的运维红线(公开用户名、成员核对等)统一见 [09](09-security-ops.md) 安全清单;与本篇机制直接相关的一条:**不得开启「限制保存内容」(protected content)**,否则 `copyMessage` 链路可能中断。建群步骤、管理员提升与取 `chat_id` 的点击路径见 [05](05-webhook-management.md) 前置准备清单。

## 核心映射

路由链(`user_id → conversation_id → Topic ID`)见总览「原理一」;落到数据库上是由唯一索引保证的双向关系(表结构见 [06](06-data-model.md)):

```text
(bot_id, telegram_user_id)
        ↕
一个 conversation(每用户至多一个 active)
        ↕
(bot_id, support_chat_id, message_thread_id)   ← 反向映射,管理员回复用
```

- 正向:用户发消息 → 按 `(bot_id, telegram_user_id)` 找 conversation → 找到 `message_thread_id` → 复制进 Topic;
- 反向:管理员在 Topic 发消息 → 按 `(bot_id, support_chat_id, message_thread_id)` 找 conversation → 找到用户 → 复制进用户私聊;
- `General` Topic(`message_thread_id = 1` 或无 thread 字段)**不绑定用户**,其中的一切消息按忽略策略处理(见 [03](03-message-pipeline.md))。

## Topic 标题规则

标题**始终由数据库当前状态重新渲染**,绝不在旧标题上做字符串追加/删除,避免图标重复或残留:

```text
正常:  👤 Alice (987654321) · #1001
高危:  ⚠️ Alice (987654321) · #1001
封禁:  🔇 Alice (987654321) · #1001
```

- `#1001` 为 `customers.id` 序号,是人类在群内快速定位用户的辅助标识;
- `(987654321)` 为用户的 Telegram 用户 ID(事实源 `customers.telegram_user_id`,来自消息的 `from.id`),用于 `/ban` 定位与审计排查;ID **永远完整显示**,截断只落在 `display_name` 上;
- 图标三种:`👤`(正常)、`⚠️`(高危名单,事实源 `customers.watchlisted`,见 [04](04-admin-commands.md))、`🔇`(封禁,事实源 `customers.blocked`,见 [04](04-admin-commands.md));两标志同时置位时封禁优先显示 `🔇`,解封后恢复 `⚠️`(解封不等于移出高危名单)。**不定义**其他状态图标(如暂停/归档),避免无对应流程的视觉噪音;
- **长度限制**:Telegram Topic 名称上限 128 字符,渲染时按 `🔇/👤 + display_name + (ID) + · #序号` 总长先扣掉图标、ID 与序号的固定长度,再对 `display_name` 截断;消息缺失 `from`(理论情况)时回退为不带 ID 的 `🔇/👤 + display_name + · #序号`;
- **刷新时机**:① `/ban`、`/unban`、`/risk`、`/unrisk` 时立即重渲染;② 每次用户入站消息时,若 `display_name` 已变化则顺带 `editForumTopic` 刷新(用户改名后标题不陈旧)。

## Bot 在支持群的权限

| 权限 | 用途 |
|------|------|
| Manage Topics | createForumTopic / editForumTopic / close / reopen |
| Send Messages | copyMessage 进 Topic、服务提示消息 |
| Delete Messages | 删除群内的 `/ban` `/unban` 命令消息 |
| Pin Messages(可选) | 置顶会话说明 |

用户不在支持群中,因此**不需要** Telegram 原生的 `can_restrict_members` / `restrictChatMember`(封禁语义见 [04](04-admin-commands.md))。

Worker 侧的 Bot 管理员身份校验(`getChatMember`)结果做**内存缓存**(TTL 约 5 分钟),不要每条消息都调用一次。

## Topic 创建流程与崩溃窗口(重要已知限制)

首次联系时的创建时序:

```text
1. conversation 置 status = 'creating' 并写入 D1     ← 意图先落库
2. 调用 createForumTopic(name = 渲染标题)
3. 拿到 message_thread_id
4. 立即写回 conversation.message_thread_id,status = 'open'
5. 复制用户首条消息进 Topic
```

**崩溃窗口**:步骤 2 成功但步骤 4 未完成时 Worker 崩溃。重试会再次 `createForumTopic`,导致同一用户出现两个 Topic。关键约束:**Bot API 没有「列举 Topic」的接口**,无法自动发现并对账已创建但未登记的 Topic。

处置预案(降级为「可发现、可人工合并」):

1. 重试路径发现 `status = 'creating'` 且无 `message_thread_id` 时,照常重试创建(重复 Topic 概率低但非零),并在重试成功后向新 Topic 发送一条**标记消息**,内容含 `customer #序号` 与时间戳,便于检索;
2. 同时写一条 `audit_logs`(action = `topic_creation_retry`,见 [06](06-data-model.md)),运维监控该事件(见 [09](09-security-ops.md));
3. 出现重复 Topic 时的人工合并:确认两个 Topic 归属同一 `customer_id` → 在旧 Topic 发公告并关闭 → 更新 `conversations.message_thread_id` 指向保留的 Topic。

这是 Phase 1/2 共同的已知限制,Phase 4 引入 DO 后可在 Topic 创建上加更强的串行保护,但「无列举接口」决定了无法彻底自动消除,预案必须保留。

## 删除 Topic

`deleteForumTopic` 日常流程**不使用**——历史永久保留是默认语义(见 [07](07-storage.md)、[08](08-reliability.md));唯一例外是管理命令 `/purge`(清除用户全部会话数据,见 [04](04-admin-commands.md)),属管理员显式发起的不可逆操作。如未来提供「关闭并归档」能力,通过 `conversations.status = 'archived'` 表达,不做物理删除。

---

下一篇:[03-message-pipeline — 消息链路与幂等状态机](03-message-pipeline.md)
