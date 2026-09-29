# 04 · 管理命令与用户管理

> **hodor 设计文档 · 04/13**
> 上一篇:[03-message-pipeline](03-message-pipeline.md) · 下一篇:[05-webhook-management](05-webhook-management.md) · [返回总览](README.md)

---

## 命令优先级

命令在普通中继逻辑之前解析(见 [03](03-message-pipeline.md) 处理顺序总览):收到管理员 Topic 消息,先判是否管理命令(`/ban` / `/unban` / `/purgemsg` / `/risk` / `/unrisk` / `/deluser`)——是则执行管理操作并结束,否则走普通出站中继。以上命令**绝不进入 `copyMessage`**,用户侧完全不可见(命令消息本身随后删除)。

## `/ban` 流程

1. 校验发送者在 `support_admins` 白名单(表见 [06](06-data-model.md));
2. 校验消息来自 `support_chat_id` 且 `message_thread_id` 有 conversation 映射(General/未知 thread → 忽略);
3. 按 thread 找到 conversation 与 customer;
4. **`customers.blocked = true`(唯一事实源写入,见「状态唯一来源」)**;
5. `editForumTopic`:按 [02](02-forum-routing.md) 标题规则从数据库当前状态重渲染(标题格式单一来源在 02,此处不重复);
6. **可选**(`CLOSE_TOPIC_ON_BAN`,默认 **关**):`closeForumTopic`。注意:Bot 能否向 closed Topic 继续发送需实测验证——若验证不通过则永久移除该选项;默认关闭的另一原因是封禁期间管理员可能仍需在 Topic 内留言存档;
7. `deleteMessage` 删除 `/ban` 命令消息;
8. 可选:向用户发送一次 `BANNED_NOTICE`(默认关,见 [03](03-message-pipeline.md) 文案模板);
9. 写 `audit_logs`(action = `ban`,记录 admin id 与 customer id,**不记录消息内容**);
10. 标记 Update 为 processed,结束处理。

## `/unban` 流程

1. 前三步校验同 `/ban`;
2. `customers.blocked = false`;
3. `editForumTopic` 按数据库当前状态重渲染标题(格式与截断规则见 [02](02-forum-routing.md),绝不在旧标题上增删字符串);
4. 若该 Topic 曾被 close(查 `conversations.status = 'closed'`),`reopenForumTopic`;
5. `deleteMessage` 删除 `/unban` 命令消息;
6. 写 `audit_logs`(action = `unban`);标记 processed。

## `/purgemsg` 流程(清理与该用户的全部消息)

清理当前 Topic 绑定用户在系统内的**全部消息**(PRD:清理和该用户的所有消息)——D1 消息行、媒体引用,以及群内 Topic 中的消息副本。**高危且不可逆,仅 `support_admins` 白名单内的管理员可执行**,并设计为两步确认:

1. 校验发送者在白名单 + 消息来自 `support_chat_id` 且 thread 有映射(同 `/ban` 前置校验;General/未知 thread → 忽略);
2. 收到 `/purgemsg`(未带 confirm)→ Bot 在本 Topic 发确认提示:`⚠️ 将清理 #<id> 的全部消息(含图片/视频/文件引用),不可逆。10 分钟内发送 /purgemsg confirm <id> 执行。`;
3. **10 分钟内、在同一 Topic 内**发送 `/purgemsg confirm <id>`,且 `<id>` 与该 Topic 绑定的 customer 序号**一致**才执行;序号不匹配(发错 Topic/写错号)或超时一律拒绝并提示作废;
4. 执行顺序(**审计先行**,与 Topic 创建「意图先落库」同一原则):
   ① 写 `audit_logs`(action = `purgemsg`,detail 含 customer_id 与 actor_id,不含消息内容);
   ② 删除该 conversation 的全部 `messages` 行(含 `media_file_id` / `r2_object_key` 引用;Phase 3 起同时删除对应 R2 对象);
   ③ 删除 `conversations` 行;
   ④ `deleteForumTopic`(整话题删除——Topic 内的用户消息、管理员回复与媒体副本随之清除);
   ⑤ 在 **General Topic** 发一条结果公告(含 `#序号`)——Topic 本体已删除,公告与审计是仅存的痕迹;
5. 重复 `/purgemsg confirm` 幂等:conversation 已不存在即视为已清理,回复提示。

设计取舍与边界:

- **为什么「清消息」要整题删除**:PRD 要求清理**所有**消息,而 Bot API 的 `deleteMessage` 只能删除 **48 小时内**的消息,逐条清除覆盖不了历史;`deleteForumTopic` 无此限制,是唯一完整的清除手段。「保留 Topic、只删 48h 内消息」的方案因达不到「所有」被否决。整题删除连带清理了会话行与 Topic 本体,故本命令的效果是「消息全清、会话重开」;
- **customer 行保留**:身份、`#序号`、封禁状态不动——用户下次发消息会新建 conversation 与新 Topic(同号新会话),对话无缝继续;「删除用户身份」不属于本命令,那是 `/deluser` 的职责(审计链完整性优先);
- **确认是无状态的**:`/purgemsg confirm <id>` 携带序号并在同一 Topic 内校验,错发到其他 Topic 会因序号不匹配被拒——不为确认引入任何存储;
- **崩溃窗口**:审计(①)先于一切删除,若中途崩溃会留下「有 purgemsg 审计但 Topic/数据仍在」的残留——残留 Topic 因无 conversation 映射已被忽略策略覆盖,由管理员在客户端手动删除,或按审计对账后重试;
- **清除范围**:系统持有的全部消息副本与引用(D1 行、群内 Topic 及其媒体副本、Phase 3 的 R2 对象)。不覆盖:用户私聊中用户收到的回复副本(属用户自己的聊天记录,Bot 无权删除)、Telegram 平台底层的媒体原件(`file_id` 所指)、`inbox_updates` 的原始 payload(投递台账,按 [07](07-storage.md) 老化策略统一处理);
- **不可恢复边界**:D1 侧可经 Time Travel(30 天)救援误删(见 [09](09-security-ops.md));Telegram 侧 Topic 删除不可逆。

> 命名注:本命令按 PRD 定名 `/purgemsg`;当前代码实现为 `/purge`(audit 值 `purge`),重命名与审计值同步属实现任务,随下一批代码变更执行。

## `/risk` / `/unrisk` 流程(高危名单)

高危名单与封禁**相互独立**:列入高危的用户**仍可正常对话**(入站照常中继、回复照常送达),系统只是持续提醒管理员多加注意——这是它与 `/ban` 的本质区别;两个标志可叠加,高危用户照常可 `/ban` / `/unban`。

`/risk` 流程(前置校验同 `/ban`):

1. `customers.watchlisted = 1`(唯一事实源,见「状态唯一来源」);
2. `editForumTopic` 重渲染标题(出现 `⚠️`,规则见 [02](02-forum-routing.md));
3. 立即在本 Topic 发一条置位提示(一次性);
4. `deleteMessage` 删除命令消息;写 `audit_logs`(action = `risk`);标记 processed。

`/unrisk` 对称:`watchlisted = 0`、标题移除 `⚠️`、审计 action = `unrisk`。

入站提示限频:高危用户的每条消息都会正常中继,但提示**不刷屏**——仅当距 `customers.last_watch_notice_at` 超过 24h(或从未提示)时,中继后向 Topic 发一条 `WATCH_NOTICE` 并更新时间戳(见 [03](03-message-pipeline.md) 入站链路第 11 步);`⚠️` 标题常驻,是持续可见的提醒。

**与封禁的正交性**:`watchlisted` 与 `blocked` 各自独立读写。高危用户被 `/ban` 时标题显示 `🔇`(封禁优先),`/unban` 后若仍在高危名单则恢复 `⚠️`——解封不等于移出名单。

## `/deluser` 流程(删除用户)

删除用户的**全部数据与身份**——customer 行、全部会话与消息、媒体引用、Topic 本体。与 `/purgemsg` 的区别:`/purgemsg` 清理全部消息但保留 customer 身份(同号新会话);`/deluser` 连身份一起删除,该用户必须重新 `/start` 才能开启全新对话(全新 `#序号`)。典型场景:响应用户「删除我的全部数据」类请求、彻底清除骚扰账号。高危且不可逆,仅白名单管理员可执行,两步确认与 `/purgemsg` 相同(`/deluser` → 10 分钟内、同一 Topic 发送 `/deluser confirm <序号>`,序号匹配才执行)。

执行顺序(**关门先于删除**——先写墓碑,防止「自动重建新用户」的竞态):

1. 写 `audit_logs`(action = `deluser`,detail 含 customer_id 与 actor_id,不含消息内容);
2. `INSERT INTO deleted_users`(墓碑:bot_id、telegram_user_id、`was_watchlisted`、deleted_at、deleted_by)——此后该用户除 `/start` 外的一切消息被静默忽略(见 [03](03-message-pipeline.md) 忽略策略);
3. 删除该 customer 名下全部 `messages` 行(含媒体引用;Phase 3 起连带 R2 对象);
4. 删除其全部 `conversations` 行;
5. 删除 `customers` 行(封禁、高危标志随行消亡);
6. `deleteForumTopic`;
7. 在 **General Topic** 发结果公告(含 `#序号`)。

**重新开启**:被删用户发送 `/start` → 删除墓碑 → 按全新用户创建 customer(新 `#序号`,发送 `WELCOME`)。墓碑中的 `was_watchlisted` 继承到新 customer(`watchlisted = 1`)——防止「删除再回来」绕过高危标记;如需解除,管理员 `/unrisk` 即可。

设计取舍:

- 重复 `/deluser confirm` 幂等:customer 已不存在即视为已删除;
- 墓碑只存 id、时间与操作者,**不含任何内容**——它本身满足「删除数据」类请求的隐私要求;
- 崩溃窗口:①② 先落库,后续步骤可按审计对账重试;
- Telegram 侧 Topic 删除不可逆;用户私聊副本与平台底层媒体不受控(边界同 `/purgemsg`)。

## 命令注册(setMyCommands,输入辅助)

`/ban`、`/unban`、`/purgemsg`、`/risk`、`/unrisk`、`/deluser` 的解析与执行**不依赖**命令菜单——即使不注册,管理员手动输入命令也照常工作。注册 `setMyCommands` 只为输入体验:管理员在群内输入 `/` 即出现自动补全与说明:

| command | 菜单描述 |
|---------|----------|
| `ban` | 封禁当前 Topic 绑定的用户 |
| `unban` | 解除当前 Topic 用户的封禁 |
| `purgemsg` | 清理当前 Topic 用户与该用户的全部消息(不可逆,需二次确认) |
| `risk` | 将当前 Topic 用户列入高危名单(仍可正常对话,持续提示) |
| `unrisk` | 将当前 Topic 用户移出高危名单 |
| `deluser` | 删除当前 Topic 用户及其全部数据(不可逆,需二次确认) |

- **注册时机**:绑定流程内(`setWebhook` 之后,见 [05](05-webhook-management.md)),调用一次;
- **作用域**:`BotCommandScopeChat`(`chat_id = support_chat_id`),命令菜单对支持群内成员可见;Phase 1 **不用** per-Topic scope(`message_thread_id` 参数)——群级已够用,命令在 General/未知 Topic 被触发也无妨,解析层按忽略策略静默丢弃(见 [03](03-message-pipeline.md));
- **失败非致命**:调用失败(限流/网络)只记 `audit_logs` 与 `last_error`,**不阻断绑定**——管理员仍可手动输入命令,重跑 `/public/setwebhook` 即可补注册;
- 到达 Worker 的仍是一条 `/ban` 文本消息,幂等、白名单校验、审计流程全部照旧,命令菜单不引入新的处理路径。

## Phase 4 命令:/help 与 /verifyon /verifyoff(规划)

以下为已合并进设计的 Phase 4 命令契约([13](13-implementation-steps.md) 步骤 18/19),落地前用户侧不可见,现有六条命令的解析与执行不受影响。与现有命令同守三条底线:白名单校验、命令绝不进入 `copyMessage`、命令消息执行后删除。

### /help(管理员帮助,步骤 19)

- 仅 `support_admins` 白名单可触发,每个 Topic 内可用(PRD:可在每个 Topic 中触发);
- 行为:在本 Topic 回复帮助文案(当前可用命令与用途,文案模板 `HELP` 见 [03](03-message-pipeline.md)),随后 `deleteMessage` 删除命令消息;
- 纯只读提示:无状态变更,不写审计。

### /verifyon /verifyoff(人机验证开关,步骤 18)

- 开关 [09](09-security-ops.md)「人机验证与频率限制」体系的总闸,仅白名单管理员可执行;
- **状态唯一来源**:`bots.verification_enabled`(0/1,Phase 4 经 Expand/Contract 加列,见 [06](06-data-model.md)、[08](08-reliability.md))——禁止在 conversations 或 KV 存第二份(同「状态唯一来源」原则);
- `/verifyon` 置 1、`/verifyoff` 置 0,各写 `audit_logs`(action = `verify_on` / `verify_off`),随后按新状态重注册命令菜单(PRD:两个命令按状态互斥展示,注册机制见「命令注册」节);
- 关闭期间 `/start` 跳过验证直接建户;开启后新 `/start` 需通过验证才建户(流程见 [09](09-security-ops.md))。

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

## 状态唯一来源(消除双源漂移)

| 状态 | 唯一来源 | 语义 | 派生表现 |
|------|----------|------|----------|
| 封禁 | `customers.blocked` | 应用层封禁 | Topic 标题 `🔇`,入站静默丢弃 |
| 高危 | `customers.watchlisted` | 提示管理员多加注意,**不影响中继** | Topic 标题 `⚠️`、入站 24h 限频提示 |
| Topic 生命周期 | `conversations.status` | `creating / open / closed / archived` | 是否允许中继、是否需 reopen |

**禁止**在 `conversations.status` 里再存一个 `blocked` 值——两处同时写必然漂移。标题图标是 `customers.blocked` 与 `customers.watchlisted` 的纯派生展示(封禁优先),渲染规则见 [02](02-forum-routing.md)。

## 相关验收

命令的测试与验收条目见 [10](10-testing.md)(命令不进 copyMessage、白名单外不可执行、标题与 D1 状态一致、`/purgemsg` 的确认与清理链路等)。

---

下一篇:[05-webhook-management — Webhook 管理与初始化](05-webhook-management.md)
