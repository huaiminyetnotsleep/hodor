# 全用户广播（General → Telegram 私聊）契约

> 2026-10-09 随全用户公告广播功能确立。对外行为事实源见 `docs/guide/features.md`；本规范约束实现与跨层安全边界。

## 1. 范围 / 触发

以下变更必须遵守本契约：General `/broadcast` 命令、广播预览与 callback、`broadcasts` 表、私聊批量发送、Telegram 错误消费、清库/归档交互。

广播是管理员工具，不是普通 relay：

- 输入只接受客服群 General（`chat_id === SUPPORT_CHAT_ID` 且 `message_thread_id` 缺失）的 `/broadcast`。
- 普通 General 消息和其他命令维持既有 ignore 行为；带非法或任意 thread 字段不得伪装为 General。
- Topic 中 `/broadcast` 只反馈去 General，不能落入普通出站中继。
- 发送目标仅为符合资格用户私聊；公告正文作为一份历史保存在 General，不向每个 Topic 发布。

## 2. 签名与数据契约

### 2.1 命令和 Telegram 参数

```text
/broadcast <标题第一行>\n<正文，可有段落空行>
```

`parseBroadcastInput(message.text) -> { title: string; body: string } | null`

`composeBroadcast(title, body, signature) -> { messageHtml: string; visibleText: string } | null`

- 首行命令参数为标题，后续内容为正文；二者 trim 后都必须非空，CRLF 归一化为 LF，内部段落换行保留。
- 系统格式为 `<b>📣 标题</b>`、正文和 `<i>— 落款</i>`；用 HTML parse mode。用户标题、正文、签名的 HTML 保留字符必须转义；输入的 Markdown/HTML 符号按普通文本显示。
- `SendMessageParams` 可选 `parse_mode: "HTML"` 和 `reply_parameters: { message_id: number }`。只有公告预览/用户投递使用 HTML；普通 relay 不携带这两个字段。
- 最终可见文本按 UTF-16 code units 做 4096 上限校验；超限拒绝，不截断、不拆分。
- 落款每次预览前实时 `getMe()` 取 `first_name`；API 失败不得回退库存名。API 成功但名称空时用 `BROADCAST_FALLBACK_SIGNATURE = "Hodor"`。

### 2.2 数据库状态

`migrations/0005_broadcasts.sql` 的 `broadcasts` 为短期任务表，一份任务一行；终态控制消息收尾后删除：

- 核心键：`id`、`bot_id`、`source_update_id`、`initiator_user_id`、`support_chat_id`。
- General 历史关联：`preview_msg_id`、`control_msg_id`、冻结的 `message_html`。
- 收件人快照：`recipient_ids_json`、`expected_count`。
- 状态：`preparing → pending → sending → completed`；取消/过期/失败分别到 `cancelled/expired/failed` 终态。
- 数量：`success_count`、`failure_count`；确认有效期 `expires_at`；生命周期 `confirmed_at/created_at/updated_at`。
- UNIQUE `(bot_id, source_update_id)` 防 webhook 发起 update 重放重复建任务。
- 部分唯一索引：每 Bot 最多一个 `sending`；每 Bot 最多一个 `preparing/pending` 草稿。草稿可与发送中任务并存，但发送中时确认新的草稿返回 busy，不排队。
- 不保存逐收件人状态；已删除的终态任务不保留收件人 ID。广播不写 `messages` 账本。

收件人资格查询（COUNT 与冻结名单必须同语义）：

```sql
SELECT t.user_id
FROM topics t
JOIN users u ON u.bot_id = t.bot_id AND u.user_id = t.user_id
WHERE t.bot_id = ? AND u.is_banned = 0
ORDER BY t.user_id;
```

不筛选 `topics.status`、`users.status`、`is_verified`、`verified_at` 或 TTL；归档/closed/未验证用户仍包括。内连接自然排除无 users 行的孤儿映射。物理删除用户、无 topic 映射或已封禁者排除。

### 2.3 状态 API

`src/store/broadcasts.ts` 是状态契约的唯一 SQL 所有者：

- `countEligibleRecipients(db, botId)` 与 `listEligibleRecipients(db, botId)` 使用相同资格谓词。
- `insertPreparingBroadcast(...)` 以 `(bot_id, source_update_id)` 关联 webhook update。
- `setBroadcastPreviewMsgId(...)` 和 `setBroadcastPendingWithControlMsgId(...)` 只允许从 `preparing` 更新；变化行数不是 1 时必须失败，不能留下有效旧按钮。
- `confirmBroadcast(...)` 使用单条条件 UPDATE 检查 bot、发起人、`pending` 和有效期，原子冻结有序 ID JSON、计数并转 `sending`；发送部分唯一索引冲突返回 `busy`。
- `cancelBroadcast(...)` 与 `expireBroadcast(...)` 只可从仍有效/已过期的 `pending` 原子转为相应终态。
- `decodeRecipientIds(json)` 对 unknown 做 fail-closed 校验：数组、最多 500 个正安全整数、严格升序且无重复；非法返回 null，调用方不得向任何用户发送。
- `completeBroadcast(...)` 仅 `sending → completed` 并一次性写入汇总成功/失败计数；行不再处于 sending 时返回 false，不得伪报完成。
- `isBroadcastSending(...)` 是每次开始下一位用户发送前的清库护栏。
- `cancelActiveBroadcasts(...)` 在 `/wipealldata` 删除 Topics 之前，将草稿置 cancelled、发送中任务置 failed（结果未知），之后清掉 broadcasts 行。

### 2.4 Webhook 与权限

- `classifyUpdate` 的广播分类仅匹配客服群 General 的合法文本 `/broadcast`；`group_callback` 对 `b:` 载荷路由至广播 callback，`d:` 和 `w:` 路由原样保持。
- 创建预览与 callback 均校验 `ADMIN_IDS`；callback 还必须匹配 `initiator_user_id`、客服群 chat、库存 control message ID、任务状态及五分钟有效期。
- 确认/取消竞态以 D1 条件 UPDATE 的 `meta.changes === 1` 裁决；输家重读状态，不得再次启动发送。

## 3. 契约与数据流

### 3.1 General 历史和确认

1. 写入 `preparing`。
2. General 发送唯一格式化公告预览并保存 message ID。
3. Bot 以 `reply_parameters.message_id` 回复预览，发确认/取消按钮并保存 control message ID。
4. 只有 control ID 已落库且状态 `pending`，该按钮才有效。
5. 成功确认后关联控制消息改为「正在发送」，确认按钮移除；用户私聊收到与 General 预览相同的 `messageHtml`。
6. 结束后将同一 control message 改为完成成功/失败总数；预览公告永久保留于 Telegram General 历史。按钮、估算人数、统计和错误文案不发给用户。
7. `cancelled/expired/failed` 的控制消息分别清键盘并显示未发送、过期或中断未知；终态任务行收尾后删除。

Telegram API 与 D1 不存在跨系统事务。预览/控制消息已发送但 message ID 落库失败时，只能用已知 ID 尽力编辑/回复使按钮失效；极端双故障可能留下孤立/重复草稿，但不得有可执行任务。callback 必须精确匹配当前 D1 的 control ID。

### 3.2 确认回调内发送

发送在确认 callback 的同一 webhook 请求中**顺序 await**，无 Cron/Queues/后台任务、无并发 blast、无逐用户账本：

1. 从 D1 原子冻结确认时符合资格的名单（最多 500；0 或超过上限转 cancelled 并更新控制消息）。
2. 向名单做一次资格复核，与冻结名单取交集；此后不逐人读库。
3. 对每个目标，在调用 Telegram 前查询任务仍为 `sending`；若清库/陈旧处理已改变或删除状态，停止后续用户，并把控制消息标为中断、结果未知。检查与单次请求之间仍有不可消除竞态，该条无法撤回。
4. 对每位用户调用 `sendMessage({ chat_id: userId, text: messageHtml, parse_mode: "HTML" })`。不改 users/topics、不打开 Topic、不恢复归档、不按验证状态门控，也不写 messages。
5. 全部结束后 `completeBroadcast` 原子写汇总。最终 General 控制消息编辑 retryable 时 webhook 可重投；重投只修复 completed 状态文案并删除任务行，不得重发用户消息。
6. `sending` 超过 10 分钟视为崩溃残留；下一次广播命令或 callback 惰性改为 failed，General 显示中断/结果未知并删任务行。不自动续发、不提供恢复按钮。

确认请求本身可能超过 webhook processing 的 60 秒认领期；同 update 重投读到仍在发送的行后只返回「发送中」并完成 webhook，不得并发第二次发送。运行时升级/断连会中断请求，内存中的实际成功数可能无法恢复；这是简化版已接受的限制。

### 3.3 配额边界

- Worker 子请求、CPU 和 elapsed time 是运行时限制，不因代码按序等待网络而消失。Cloudflare Free 普通 subrequest 上限可能低于 100–300 人发送所需调用数。
- 因此 500 是应用逻辑硬上限，**不是任何 Cloudflare 套餐都能完成的保证**。上线部署必须具备足够的 Workers 子请求额度；未验证套餐时不能承诺目标规模、无中断或固定耗时。
- 禁止为越过当前请求额度而静默增加 Cron、Queue、`waitUntil`、并发轰炸或新绑定；这类架构变化必须回到产品规划。

## 4. 校验与错误矩阵

| 条件 | 行为 |
| --- | --- |
| General 管理员命令、输入完整、估计人数 1–500 | 建预览与待确认 control message |
| 空标题/正文、格式超长、0 用户、预览人数 >500 | 不创建可确认任务，不发用户公告 |
| 非管理员、外群/私聊、General 非 `/broadcast` | 不建任务、不群发；保持各自既有 ignore/提示语义 |
| Topic 中 `/broadcast` | 仅提示去 General，绝不中继给 Topic 用户 |
| `getMe` retryable | 抛出供 webhook 重投；不以旧 display name 继续 |
| `getMe` permanent | General 尽力提示，终止创建 |
| HTML 特殊字符输入 | `&`, `<`, `>` 转义后作为文字；不允许注入标记 |
| callback 非发起人/已非管理员/外 chat/错误 control id | toast 拒绝或标记已处理，不发送 |
| callback 已超时、取消或重复 | 原子终态；重复 callback 不再发送 |
| 同 Bot 已有 `sending` | pending 保留至过期，toast 稍后再试；不排队 |
| 每位私聊 `sendMessage` permanent（含403） | 失败计数 +1，继续后续用户；不改变 user ban 状态 |
| retryable 且有 `retryAfterSeconds` | client 先按既有规则对短429至多原地重试一次；广播层最多 sleep ≤10s 后再重试一次；仍失败计失败继续 |
| 其他 retryable（网络/5xx/未知） | 失败计数 +1 后继续；不通用重试、不自动补发 |
| 任务被 wipe/清理改状态或删除 | 下一用户前停止；General 标记结果未知，不能报完整完成 |
| 完成统计 edit retryable | 抛出重投；只修复 General 文案/删除 completed 行，不能重发用户 |
| 完成统计 edit permanent | warn、删除终态任务，不回滚已发消息 |
| Worker 超限/请求运行时中断 | 不自动续发；10 分钟陈旧清理后 General 标记中断/结果未知 |

## 5. Good / Base / Bad

- **Good**：一次确认原子冻结不超 500 收件人；私聊发送顺序完成；单条错误只影响汇总并继续；General 预览与用户收到内容严格相同。
- **Base**：发送中清库时已调用中的单条 Telegram 请求可能完成；循环检测到状态变化后停止后续用户，结果以“中断/未知”呈现。
- **Bad**：把“500 硬上限”当作 Free 套餐可用性保证；在 Topic 接受 `/broadcast` 并走普通 relay；对 HTML 用户输入不转义；把 General 控制按钮消息内容发给客户；webhook 重投从头发送；403 后自动标记用户被 ban；retryable 递归无限重试。

## 6. 必需测试

- `broadcast-format.test.ts`：首行标题、正文多段、CRLF、命令后缀、空字段；`&<>` 不注入 HTML；Hodor fallback；最终可见长度 4096 边界；emoji 计数。
- `classify.test.ts` / `broadcast-webhook.test.ts`：General 精确路由、thread 缺失条件、畸形 thread、Topic/外群/私聊不创建任务；管理员授权。
- `broadcast-store.test.ts`：收件人资格正确排除 banned/孤儿并包含 archived/closed/unverified；确认/取消 CAS；busy 单活跃；JSON fail-closed；过期/陈旧清理；wipe 状态转移；完成状态仅 from sending。
- `broadcast-webhook.test.ts`：发起人/控制 message id/五分钟/重复 callback；100/300 发送顺序及汇总；permanent、长/短429与网络失败；重投 completed 仅修复 control 不重发；wipe 后停止下一收件人；普通 relay 参数不带 HTML。
- `schema.test.ts`、`selfcheck-tables.test.ts`：广播表约束、唯一索引、第八表契约；`/health` 响应保持不变。
- 质量门槛：`npm run typecheck`、`npm test`、`npm run docs:build`、`task.py validate`、`git diff --check`；Telegram test fetch stub 必须拒绝所有真实网络。

## 7. Wrong vs Correct

### Wrong：确认后把全部用户当作 webhook 可无限循环对象

```ts
for (const userId of users) {
  await client.sendMessage({ chat_id: userId, text: rawInput });
}
```

这会把用户输入当作格式化 payload、缺少生命周期/收件人/重投约束，并可能越过 Worker 的子请求额度。

### Correct：用冻结并校验的公告和名单，复核任务状态，顺序统计错误

```ts
const ids = decodeRecipientIds(row.recipient_ids_json);
if (!ids) return failClosed();
const eligible = new Set(await listEligibleRecipients(db, botId));
for (const userId of ids.filter((id) => eligible.has(id))) {
  if (!(await isBroadcastSending(db, botId, row.id))) break;
  const result = await client.sendMessage({
    chat_id: userId,
    text: row.message_html,
    parse_mode: "HTML",
  });
  // 按本规范三态矩阵计数；有限重试，绝不重跑整批。
}
```
