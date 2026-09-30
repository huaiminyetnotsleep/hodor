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

## 必需测试

- 分类矩阵 + 两条 429 路径,并断言调用次数(test/telegram-client.test.ts)。
- 消费方(S3 起):每个 `kind` 分支都要断言最终的 inbox 状态 / HTTP 响应。

## 已知后续(记录在各任务 PRD 中)

- ~~S5 决策:`permanent` 是否增加 `errorCode?: number`~~ —— 已在 S5(2026-09-28)解决:
  `permanent` 携带 `errorCode?: number`(信封 `error_code` 透传;`200 + ok:false` 路径
  同样如此)。消费方按数字码分支,绝不按 `errorMessage` 文本。
- ~~S3:补充缺失场景「200 + 合法 JSON 但无 `ok` 字段 → retryable」~~ —— 已完成
  (test/telegram-client.test.ts)。
