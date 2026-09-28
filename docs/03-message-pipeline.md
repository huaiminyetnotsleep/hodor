# 03 · 消息链路与幂等状态机

> **hodor 设计文档 · 03/12**
> 上一篇:[02-forum-routing](02-forum-routing.md) · 下一篇:[04-admin-commands](04-admin-commands.md) · [返回总览](README.md)

本篇是全项目的核心:一条 Update 从进入 Worker 到处理完成的全过程。**业务逻辑与触发方式解耦**——本文的处理函数在 Phase 1 由 Webhook 同步调用,Phase 2 由 Queue 消费调用,代码不变。

---

## 处理顺序总览

```text
收到 Update
    │
    ▼
① Secret 校验(失败 → 401,直接返回)
    │
    ▼
② inbox 幂等登记(按状态决定是否执行,见下文)
    │
    ▼
③ 来源分类
    ├── 私聊消息(用户 → Bot)      → 入站链路
    ├── 支持群 Topic 消息(管理员) → 校验后先判命令:
    │       ├── /ban /unban /purge /risk /unrisk /deluser → 管理命令(04)
    │       └── 普通消息           → 出站链路
    └── 其他(见「忽略策略」)      → 标记 processed,返回 200
    │
    ▼
④ 标记 processed,返回 200
   (任何一步失败 → 按错误分类决定:重试 or 记永久失败,见「错误处理」)
```

命令必须在普通中继逻辑**之前**解析,`/ban`、`/unban`、`/purge` 绝不进入 `copyMessage`。

---

## 幂等状态机(按「处理状态」而非「行是否存在」判断)

Telegram Webhook 按至少一次投递:Worker 返回非 2xx 或超时,Telegram 会以递增退避重试同一 Update。因此:

- 幂等键 `(bot_id, telegram_update_id)` 只回答「**是否收过**」;
- 是否重新执行,必须看 `inbox_updates.status`(pending / processed / failed)——**「登记过」≠「处理过」**,否则处理失败的消息会被重试的幂等命中而静默丢失。

```text
收到 Update
    │
    ▼
INSERT INTO inbox_updates(..., status='pending', attempts=0)
ON CONFLICT(bot_id, telegram_update_id) DO NOTHING
    │
    ├── 插入成功(新 Update)─────────────────────┐
    │                                            │
    └── 冲突(已存在)→ 读取现有行                 │
            │                                    │
            ├── status = processed ──> 返回 200,跳过
            │
            ├── status = failed   ──> 返回 200,跳过
            │                         (超上限,人工 DLQ,见 08)
            │
            └── status = pending  ──> attempts < MAX_ATTEMPTS?
                                      ├── 是 → 作为重试,重新执行 ──┐
                                      └── 否 → 置 failed,返回 200 │
                                                                   │
    执行处理 <────────────────────────────────────────────────────┘
    │
    ├── 成功 → status = processed,返回 200
    │
    └── 失败 → attempts += 1
                ├── attempts < MAX_ATTEMPTS → 返回 5xx(让 Telegram 重试)
                └── attempts ≥ MAX_ATTEMPTS → status = failed,返回 200
                                              (进入 Phase 1 手工 DLQ,运维处理见 08/09)
```

要点:

- `MAX_ATTEMPTS` 建议为 8;超限行**必须返回 200** 停止 Telegram 无限重投,由运维介入(见 [08](08-reliability.md));
- **blocked 用户的入站消息标记为 `processed` 而非 `failed`**——「拒绝服务」是正常业务结果,不是故障,不能触发重试;
- D1 写入串行,`INSERT ... ON CONFLICT DO NOTHING` 后以 `meta.changes` 判断是否新插入,不要先 SELECT 再 INSERT;
- 关键持久化(幂等登记、messages 落库)必须在返回响应前完成,**不得依赖 `waitUntil`**(完整规则见 [08](08-reliability.md));
- `update_id` 序列**每个 Bot 独立递增**:跨 Bot 换绑时必须先归档台账,否则新 Bot 的低位 `update_id` 会被旧台账幂等命中而静默吞掉(换绑 Runbook 见 [05](05-webhook-management.md))。

---

## 入站链路(用户消息 → Topic)

```text
┌────────┐      私聊       ┌──────────┐     Webhook     ┌──────────┐
│ 用户 A │ ───────────────> │ Telegram │ ─────────────> │ Worker   │
└────────┘                 └──────────┘                └────┬─────┘
                                                             │
                                             ①② Secret 校验 + 幂等
                                                             ▼
                                              查询/创建 customer
                                                             │
                                              blocked? ──是──> 标记 processed,结束
                                                             │否
                                              bot_blocked_by_user 置 false(403 处理)
                                              watchlisted? ──> 中继后 24h 限频提示(04)
                                                             │
                                              查询/创建 conversation + Topic
                                              (首次:createForumTopic,见 02 崩溃窗口)
                                                             │
                                              display_name 变化? → editForumTopic 刷新标题
                                                             │
                                              copyMessage → 私有群 Topic A
                                                             │
                                              messages 落库 → processed → 200
```

详细步骤:

1. 用户在 Telegram 私聊 Bot 发送消息(任意类型:文本、图片、语音、文件……);
2. Telegram POST 到 Worker Webhook,Worker 校验 Secret;
3. 按 `bot_id + update_id` 做幂等登记(状态机见上);
4. 查询 customer;不存在时先查 `deleted_users` 墓碑(见 [04](04-admin-commands.md) `/deluser`):
   - 墓碑存在且消息**不是** `/start` → 静默忽略(见忽略策略);
   - 墓碑存在且是 `/start` → 删除墓碑,按全新用户创建(新 `#序号`;高危标记按墓碑 `was_watchlisted` 继承),发送 `WELCOME`;
   - 无墓碑 → 正常创建 customer;
5. 若 `customers.blocked = true`:标记 processed 并结束——默认**静默丢弃**;可选配置为发送封禁提示(见「用户侧文案模板」);
6. 若 `customers.bot_blocked_by_user = true`:置回 false(用户能发消息说明已恢复,见「用户拉黑 Bot 的 403 处理」);
7. 查询 conversation;不存在则创建:先写 `status = 'creating'`,再 `createForumTopic`,成功后写回 `message_thread_id` 并置 `open`(崩溃窗口预案见 [02](02-forum-routing.md));
8. 用户 `display_name` / `username` 与库中不一致时,更新 customer 并 `editForumTopic` 重渲染标题(规则见 02);
9. `copyMessage`(from = 用户私聊, to = 支持群 Topic)复制用户消息;
10. 写入 `messages` 记录(方向、源/目标 chat+message id、内容类型、文本);
11. 高危提示:若 `customers.watchlisted = 1` 且距 `last_watch_notice_at` ≥ 24h(或从未提示)→ 向 Topic 发 `WATCH_NOTICE` 并更新时间戳(24h 限频,不刷屏;`⚠️` 标题常驻,见 [04](04-admin-commands.md));
12. 标记 processed,返回 200。

## 出站链路(管理员 Topic 消息 → 用户私聊)

```text
┌──────────┐     Topic 消息     ┌────────────────┐     Webhook     ┌──────────┐
│ 管理员    │ ─────────────────> │ 私有群 Topic    │ ─────────────> │ Worker   │
└──────────┘                    └────────────────┘                └────┬─────┘
                                                                     │
                                              ①② Secret 校验 + 幂等
                                                                     ▼
                                        ③ 校验(全部通过才继续):
                                           · 消息来自 support_chat_id
                                           · message_thread_id 有 conversation 映射
                                           · 发送者在 support_admins 白名单
                                           · Bot 仍是支持群管理员(getChatMember,结果缓存)
                                                                     │
                                        是否 /ban /unban? ──是──> 管理命令(04)
                                                                     │否
                                                                     ▼
                                        copyMessage(from = 群 Topic 消息,
                                                    to   = 用户私聊)
                                          │
                                          ├── 403 → 拉黑处理(见下)
                                          └── 成功 → messages 落库 → processed → 200
```

校验不通过(未知 thread、非白名单成员、General Topic)一律**静默忽略**并标记 processed,不回错误提示给群(避免在客服群里制造噪音)。

### 用户拉黑 Bot 的 403 处理(避免管理员盲回复)

用户删除会话或拉黑 Bot 后,发往用户私聊的调用返回 403。若不处理,管理员的每条回复都静默失败,管理员以为已答复,实际用户一条都没收到。

```text
copyMessage → 用户私聊
    │
    ├── 403(bot was blocked by the user)
    │       │
    │       ▼
    │   customers.bot_blocked_by_user = true
    │       │
    │       ▼
    │   在 Topic 发送服务提示:
    │   「⚠️ 用户已停止与 Bot 的对话,回复暂时无法送达」
    │   (仅在标志 false→true 跳变时发送一次)
    │
    └── 用户下次发来消息(入站链路第 6 步)
            │
            ▼
        置回 false,并在 Topic 发送:
        「✅ 用户已恢复对话」
```

标志生效期间,管理员消息**仍照常尝试发送**(万一用户已解除,消息就能送达),403 只刷新告警时间戳,不重复刷屏。

---

## Update 结构速查(Phase 1 解析范围)

一条 Update 分两层:顶层「信封」+ 内层内容。官方完整定义见 [12](12-references.md) 的 Update / Message 对象链接。

顶层字段:

- `update_id`:**必有**,全局递增——幂等键 `telegram_update_id` 即取自此值;
- 其余为内容字段,**互斥且可选**,一条 Update 只出现其一:`message`、`edited_message`、`channel_post`、`callback_query`、`my_chat_member`、`poll` 等(全集见官方文档)。

Phase 1 `allowed_updates = ["message"]`(见下节),实际只会收到 `message`,其余类型 Telegram 不投递。

`message` 对象字段很多,Phase 1 实际读取的只有:

| 字段 | 用途 |
|------|------|
| `message_id` | `messages` 落库与溯源 |
| `from.id` | 定位/创建 customer;出站链路查 `support_admins` 白名单 |
| `from.first_name` / `last_name` / `username` | `display_name` 渲染与 Topic 标题刷新(见 02) |
| `chat.id` / `chat.type` | 区分用户私聊与支持群(来源分类) |
| `message_thread_id` | Topic 路由键(反向映射);缺失或 `1`(General)→ 忽略 |
| `text` / `caption` | 复制的内容文本(落库) |

其余字段的处理原则:

- 媒体内容(`photo` / `voice` / `document` 等):**不解析文件本体**,入站/出站仍用 `copyMessage` 由 Telegram 原样复制,落库只记内容类型;媒体本体随 Topic 留在 Telegram 存储(三级存储见 [07](07-storage.md)),R2 归档是 Phase 3 可选项;
- `reply_to_message` 等上下文字段:不参与路由——Topic 即路由键(见 [02](02-forum-routing.md)),回复关系不改变投递目标;
- `entities`(格式化实体):不解析,复制由 Telegram 侧完成,无需重建渲染;
- 服务消息(入群、置顶、Topic 创建等):按下方「忽略策略」处理。

解析实现注意:内容字段全部可选,**必须判空**,不得假定 `text` 存在;一条 Update 只有一个内容字段,收到 `message` 以外的字段按忽略策略标记 processed。

---

## 忽略策略(边界消息,Phase 1 全部「静默 + processed」)

| 情况 | 处理 |
|------|------|
| `allowed_updates` 之外的类型 | 不会投递(见下) |
| `edited_message`(用户编辑消息) | **Phase 1 忽略**:Topic 内不更新,历史以首版为准;如需同步编辑属 Phase 2+ |
| 用户删除消息 | Telegram 不推送删除事件,无法感知,接受 |
| General Topic(`thread=1` 或无 thread) | 忽略(公告区,不绑定用户) |
| 已删除用户(`deleted_users` 内)的非 `/start` 消息 | 静默忽略 + processed(`/start` 可重新开启,见 [04](04-admin-commands.md)) |
| 未知 `message_thread_id` | 忽略(可能是管理员手建 Topic 或服务消息) |
| 支持群内非白名单成员的消息 | 忽略 |
| Bot 自己发出的消息 | **不会以 Update 形式回投**,天然无回环——这是本架构的安全前提,实现中不做特殊处理 |
| 群内服务消息(入群、置顶、Topic 创建等) | 忽略 |

`setWebhook` 时显式设置:

```text
allowed_updates = ["message"]
```

既减少无关投递,也把「编辑如何处理」的选择固定为显式决策。

## Telegram API 错误分类与处理

| 错误 | 含义 | 处理 |
|------|------|------|
| 429 + `parameters.retry_after` | 限流(Bot 对同一群约 20 条/分钟,对同一私聊约 1 条/秒) | 若 `retry_after` ≤ 3s:等待后原地重试一次(计入本次处理);否则置本次处理失败 → 5xx → Telegram Webhook 重试,与幂等状态机闭环 |
| 403(发往用户) | 用户拉黑/删除会话 | 403 处理(见上);**标记 processed**(重试也无意义),Topic 内已提示管理员 |
| 400 Bad Request | 永久错误(如源消息已被删除导致无法 copy) | 记录 `last_error`,**标记 processed**——毒丸消息不可无限重试 |
| 5xx / 网络错误 | 临时故障 | 失败 → 5xx → Webhook 重试 |

分类必须落在 Telegram client 模块内(见 [01](01-architecture.md) 模块划分),pipeline 只收到「成功 / 可重试失败 / 永久失败」三种结果。

## 用户侧文案模板

文案集中存放(Phase 1 用常量,后续可移入 KV),便于统一修改:

| 模板 | 触发 | 默认文案 |
|------|------|----------|
| `WELCOME` | 用户 `/start` | 简短说明用途与响应预期 |
| `BANNED_NOTICE` | 被 `/ban` 时(可选,默认关) | 「你已被暂时停止服务」 |
| `REJECTED`(可选,默认关) | blocked 期间用户再来消息 | 静默为默认;开启时最多每 24h 提示一次 |
| `WATCH_NOTICE` | 高危用户入站(24h 限频,见 04) | 「⚠️ 该用户在高危名单,请多加注意」 |

## 已知限制:并发乱序

同一用户连发多条消息时,多个 Webhook 请求可能并发执行(Worker 无跨请求串行保证),Topic 内消息顺序可能与发送顺序不一致。低流量下罕见且无害(客服场景消息自带上下文),Phase 4 引入 per-Topic Durable Objects 后消除(见 [08](08-reliability.md)、[11](11-roadmap.md))。

---

下一篇:[04-admin-commands — 管理命令与封禁](04-admin-commands.md)
