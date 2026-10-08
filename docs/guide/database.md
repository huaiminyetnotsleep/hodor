# 数据表

hodor 只依赖一个 D1 数据库，共六张表。

**全局约定**：

- 所有表带 `bot_id` 维度（bot 的 Telegram 用户 ID），为多机器人（P2）预留；v1 恒为当前 bot 的 ID
- 时间戳统一 ISO-8601 UTC 文本
- 布尔值用 `0` / `1` 整数

## bots — bot 身份

`setwebhook` 绑定时由 `getMe` 自动写入 / 更新。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bot_id` | INTEGER PK | bot 的 Telegram 用户 ID |
| `username` | TEXT | @username |
| `display_name` | TEXT | bot 显示名称 |
| `created_at` | TEXT | 首次绑定时间 |

## users — 用户档案、验证与限频状态

UNIQUE `(bot_id, user_id)`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bot_id` / `user_id` | INTEGER | 联合唯一，用户 Telegram ID |
| `first_name` / `last_name` / `username` | TEXT | 展示缓存，置顶信息用 |
| `status` | TEXT | `active` / `deleted`（`/deluser` 后置 deleted） |
| `is_banned` | 0/1 | `/ban` 禁言标记 |
| `is_risk` | 0/1 | `/risk` 高危标记 |
| `is_verified` / `verified_at` | 0/1, TEXT | 验证状态与通过时间 |
| `verify_answer` / `verify_msg_id` | INTEGER | 待验证题目的正确答案与验证消息 ID（出题时写入，通过后清空） |
| `rate_window_start` / `rate_count` | TEXT, INTEGER | 60 秒固定窗口限频计数 |
| `last_notice_at` | TEXT | 提示类回复（欢迎语 / 验证码 / 禁言 / 超限提示）的限频时间戳，每用户每分钟 1 次 |
| `risk_notice_at` | TEXT | 高危用户 topic 提醒的上次发出时间（24 小时窗口）；提醒发出时写入，`/risk` 重新标记时清空（窗口重置） |
| `first_seen_at` / `last_seen_at` | TEXT | 首次 / 最近活跃时间 |

## topics — 用户 ↔ topic 双向映射（核心表）

UNIQUE `(bot_id, user_id)` **和** UNIQUE `(bot_id, thread_id)` 双向唯一：

- 入站：按 `(bot_id, user_id)` 查转发目标 topic
- 出站：管理员在 topic 发言，按 `(bot_id, thread_id)` 反查目标用户

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bot_id` / `user_id` | INTEGER | 联合唯一，所属用户 |
| `thread_id` | INTEGER | topic 的 `message_thread_id`，与 bot_id 联合唯一 |
| `title` | TEXT | 话题名，取用户昵称（`first_name`，回退 `@username` / 用户 ID） |
| `status` | TEXT | `open` / `closed`（`/deluser` 后 closed，用户重新 start 时 reopen） |
| `pinned_msg_id` | INTEGER | 置顶的用户信息消息 ID（建档置顶时写入；昵称变更自动刷新，risk / unrisk / deluser 后编辑更新） |
| `note` | TEXT | 管理员备注（`/note` 写入、`/unnote` 清空，展示于置顶信息）；随 topic 终身保留，deluser 后重开仍在 |
| `created_at` / `closed_at` | TEXT | |

::: tip 设计意图
`/deluser` 只把 `status` 置为 `closed`，**不删行**——这是「一个人终身一个 topic」复用语义的基础：用户重新 `/start` 时按 `(bot_id, user_id)` 找到原 topic 重开即可，不需要墓碑表。
:::

## messages — 消息账本

`/purgemsg`（`deleteMessages` 需要 message_id 列表）与运维查询的数据来源。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 自增 |
| `bot_id` / `user_id` / `thread_id` | INTEGER | 归属 |
| `direction` | TEXT | `in`（用户 → 群）/ `out`（群 → 用户） |
| `group_msg_id` | INTEGER | 群内消息 ID（`/purgemsg` 用） |
| `private_msg_id` | INTEGER | 私聊侧消息 ID |
| `content_type` | TEXT | text / photo / video / voice / audio / document / sticker / animation |
| `created_at` | TEXT | |

索引：`(thread_id, created_at)`、`(user_id, created_at)`。

## settings — 运行时开关

| key（PK） | value | 说明 |
| --- | --- | --- |
| `verify_enabled` | `1` / `0` | `/verifyon` / `/verifyoff` |
| `verify_mode` | `math` / `button` | `/verifymode` |

存库而非环境变量的原因：命令切换需要即时生效，不改 env、不重新部署。

## processed_updates — 幂等与重试

UNIQUE `(bot_id, update_id)`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | TEXT | `processing`（认领占位，处理成功后置 `processed`）/ `processed` / `failed` |
| `attempts` | INTEGER | 失败重推计数，每次认领接管 +1，≥ `MAX_ATTEMPTS` 置 `failed` 跳过（防毒丸） |
| `created_at` | TEXT | 最近认领时间（每次重试 / 接管刷新）；超过 60 秒的 `processing` 行视为崩溃残留，可被下一次重推接管 |

## 表间关系

```
bots ──1:n── users ──1:1── topics
              │              │
              └──1:n── messages ──┘   （messages 同时归属 user 与 topic）

settings、processed_updates 为独立表
```
