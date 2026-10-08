# 错误处理 —— Telegram 三态语言

> 所有 Telegram API 错误如何分类与消费。S2(2026-09-28)确立。

---

## 约定:TelegramResult 是流水线代码唯一的错误语言

**内容**:`src/telegram/types.ts` 定义 `TelegramResult<T> = TelegramOk<T> | TelegramError`,
其中 `TelegramError.kind` 为 `'retryable' | 'permanent'`(可选 `retryAfterSeconds`、
`errorMessage`;`permanent` 还携带 `errorCode?: number`)。HTTP/JSON 细节的分类**只**
发生在 `src/telegram/client.ts`(`request()`)内部;流水线模块(S3 起)永远看不到
状态码——只根据 `kind` 分支。

**原因**:落实 docs/03 的规则——S5 将 403 分支为 `bot_blocked_by_user` 时,无需在
HTTP 层嗅探字符串;单一分类点,可独立测试。

### 分类矩阵(逐字摘自 design.md 决策表)

| Telegram 响应 | Kind | 附加语义 |
|---|---|---|
| 200 + `ok:true` | Ok | 结果直接透传 |
| 200 + `ok:false` | permanent | errorMessage = description;信封有 `error_code` 时透传为 `errorCode` |
| 429,`retry_after ≤ 3s` | **原地重试恰好一次**(setTimeout) | 仍 429 → retryable 携带新值;绝不重试两次 |
| 429,`retry_after > 3s` 或缺失 | retryable | 向上重新抛出 → inbox 5xx → Telegram 重投递 |
| 403 | permanent | `errorCode === 403` 驱动 `bot_blocked_by_user`(S5)——按数字码分支,绝不嗅探字符串 |
| 400 | permanent(毒丸) | 绝不重试;`errorCode` 透传 |
| 5xx / 网络错误 / 非 JSON | retryable | |
| 其他 4xx | permanent | 保守默认;`errorCode` 透传 |

### 消费方规则(S3 起)

- `retryable` → 让请求失败(5xx),交给 inbox 状态机 + Telegram 重投递去重试;
  绝不在流水线代码内循环。
- `permanent` → 按 docs/03 逐项决定:标记 `processed`(毒丸 / 被屏蔽用户),绝不返回 5xx。
- 不要在 `client.ts` 之外新增分类分支。

## 场景:管线副作用的排序与系统消息语义(阶段 3 / T22–T26,2026-09-30 确立)

### 1. 范围 / 触发条件

在中继管线(入站 / 出站)新增任何副作用(欢迎语、置顶、提示、验证码、账本、
未来阶段的限频 / 封禁提示等)时,本节排序与语义契约生效。

### 2. 签名

- 入站 canonical order:`extractContent → ensureUser → topic(含置顶 4a/4b) →
  欢迎语(claimNoticeSlot 门控) → relayContent → insertMessage`。
- 出站 canonical order:`extractContent → 管理员校验 → 反查绑定(未绑定/closed →
  T26 提示后结束) → relayContent → insertMessage`。

### 3. 契约

- **非中继副作用一律排在中继之前;中继之后只允许账本写入**。系统类消息
  (欢迎 / 置顶 / 提示)**不入 messages 账本**(非对话内容)。
- 账本行只在**中继成功后**写入;中继 permanent(消息被丢弃)不写行。
- 频控提示走原子认领:`UPDATE ... SET last_notice_at=? WHERE ...
  (last_notice_at IS NULL OR last_notice_at <= ?) AND` `meta.changes === 1` 才发送。
- **账本后附着物完全 best-effort(阶段 5 确立)**:治理提醒类副作用(高危 24h
  提醒)排在中继与账本**全部成功之后**,先原子认领时间窗再发送,**两种失败一律
  warn 吞、绝不抛**——它是主链的附着物而非环节,抛出会让重推重发用户消息
  (放大面);窗口已消耗,本轮丢失由下个窗口的下一条消息补上。

### 4. 校验与错误矩阵

| 副作用 | retryable | permanent |
|---|---|---|
| 中继前副作用(置顶 / 欢迎 / 提示) | 抛 → 重推重走该步骤(中继未发生,不产生重复中继) | warn + 跳过,主流程继续 |
| 中继本身 | 抛 → 重推(at-least-once 已知代价) | warn + 消息丢弃,**不写账本** |
| 账本 insertMessage | 原样抛 → 重推(可能重发一次中继,绝不提前 markProcessed 掩盖) | —(D1 错误一律按 retryable 对待) |
| claimNoticeSlot 已赢但发送失败 | 抛;slot 已消耗,宁可丢一条欢迎语也不重复轰炸 | warn + 跳过 |
| 账本后附着物(高危 24h 提醒,阶段 5) | **warn 吞(不抛)**——防重推放大用户消息重复 | warn 吞 |
| 命令内置顶刷新(阶段 5) | warn 吞(best-effort——确认回复已保证管理员反馈) | warn 吞 |

### 5. 正例 / 基线 / 反例

- **正例**:欢迎语 send 抛 retryable → 整条 update 5xx → 重推时 slot 已占、
  topic 已在,中继只发生一次。
- **基线**:中继成功、账本写失败 → 500 重推 → 中继可能重发一次 + 账本行最终写入
  (test/inbound-ledger-failure.test.ts 固化:保持 processing、不提前标记)。
- **反例**:把欢迎语排在中继之后——欢迎语 retryable 失败会连带已发出的中继一起
  重推,制造无谓的用户消息重复。

### 6. 必需测试

每个新增副作用的用例必须断言:三态各自路径的最终 inbox 状态、系统消息不产生
账本行、以及「该副作用失败时中继不重复」(排序保证)。

### 7. 错误 vs 正确

#### 错误

```ts
await relayContent(...);          // 先中继
await sendWelcome(...);           // 欢迎失败 retryable → 抛 → 重推 → 中继重复
```

#### 正确

```ts
await maybeSendWelcome(...);      // 先副作用(失败可安全重推)
await relayContent(...);          // 后中继
await insertMessage(...);         // 中继之后只有账本(失败抛,at-least-once 已定稿)
```

## 必需测试

- 分类矩阵 + 两条 429 路径,并断言调用次数(test/telegram-client.test.ts)。
- 消费方(S3 起):每个 `kind` 分支都要断言最终的 inbox 状态 / HTTP 响应。

## 已知后续(记录在各任务 PRD 中)

- ~~S5 决策:`permanent` 是否增加 `errorCode?: number`~~ —— 已在 S5(2026-09-28)解决:
  `permanent` 携带 `errorCode?: number`(信封 `error_code` 透传;`200 + ok:false` 路径
  同样如此)。消费方按数字码分支,绝不按 `errorMessage` 文本。
- ~~S3:补充缺失场景「200 + 合法 JSON 但无 `ok` 字段 → retryable」~~ —— 已完成
  (test/telegram-client.test.ts)。
