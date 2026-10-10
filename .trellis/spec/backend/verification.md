# 用户验证（Turnstile 模式与挑战栅栏）

> 2026-10-09 Turnstile 任务确立。约束 `src/verification/*`、`src/routes/verify.ts`、
> `src/pipeline/verify.ts` 出题/回调链与 users 栅栏原语。schema 与 settings 语义的
> 唯一事实源是 [数据库规范](./database.md) 与 `docs/guide/database.md`；本文记录
> 验证域的可执行契约与易错点。

---

## 场景：改动验证链路（出题 / 网页完成 / 回调完成 / 身份校验）

### 1. Scope / Trigger

- 触碰 `src/verification/telegramInitData.ts`、`src/verification/turnstile.ts`、
  `src/verification/request.ts`、`src/routes/verify.ts`，或 users 栅栏原语
  （reserve / attach / clear / claim / complete）时适用。

### 2. Signatures

- 栅栏原语（`src/store/users.ts`，全部单语句条件 UPDATE，`meta.changes` 判定）：
  `reserveVerificationRequest`（条件预留 hash/expiry/generation）→
  `attachVerifyMessage`（CAS 回填 msgId）→ `clearVerificationRequest`（CAS 清理）→
  `claimVerifySubmit`（`verify_submit_not_before` 15 秒原子节流）→
  `completeTurnstileVerification` / `completeCallbackVerification`（最终裁决）。
- 身份：`verifyInitData(rawInitData, botToken, now)` → 已认证 user 或拒绝。
- 上游：`verifyTurnstileToken(...)` → `passed | rejected | unavailable` 结构化结果。

### 3. Contracts

- **出题顺序不可倒置**：生成 32 字节 nonce（`crypto.getRandomValues`，URL 用 64 hex，
  D1 只存 SHA-256 摘要）→ 条件预留 → 发送 Telegram → CAS 回填 msgId → 失败按
  hash+generation CAS 清理。禁止「发送成功后再无条件落 pending」。
- **网页最终裁决是单条条件 UPDATE**：hash / generation / expiry / 本次认领标识 /
  未封禁 / 未验证 / SQL 内实测 mode=turnstile 且 enabled=1；Siteverify await 之后
  还要复核 initData 年龄。`meta.changes===1` 才算通过并同语句清全部 pending 列。
- **Telegram initData 校验必须用官方 Bot Token HMAC 规则**（官方文档对此有歧义，
  勿「顺手修正」）：data-check-string 排除 `hash`、**保留 `signature`**（双字段排除
  是第三方 Ed25519 规则，不适用于 HMAC）；`key = HMAC-SHA256(key="WebAppData",
  message=botToken)` 保持**二进制**再做第二次 HMAC；十六进制常量时间比较；
  `auth_date` ≤ 300 秒 + 30 秒未来偏差；单次解析、拒绝重复键。
- **Turnstile 客户端独立于 Telegram client**：固定 siteverify endpoint、5 秒超时、
  同 idempotency_key 至多重试一次、success 后强制核对 hostname / action / cdata；
  结果类型独立，**不得**复用 `TelegramResult` 或在 `src/telegram/client.ts` 加
  Cloudflare 分支。
- `GET /verify` 页面不回显用户资料；POST API 不接受客户端自报 user/bot id，
  **绝不** ensureUser / UPSERT 重建用户行。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| ban→unban 后旧请求 | 旧裁决必败（`setBanned(true)` 同 UPDATE 清 hash；解封不恢复） |
| 并发双提交 | 恰一胜（最终 CAS）；败者 409，不刷新 `verified_at` |
| 请求过期 / 版本不符 | 410 / 409，回 Bot 重新发起 |
| 缺 initData 的外部浏览器 | 页面仅提示返回 Bot，不发完成请求 |
| 上游 unavailable | 有限重试后 503；保留当前请求可重试，不清 pending |
| D1 已提交、通知失败 | 不回滚验证、不重建请求（网页通知一律 warn） |

### 5. Good / Base / Bad

- **Good**：改动栅栏原语时同步更新 store 层并发/生命周期用例。
- **Base**：新增验证模式时复用同一组四列栅栏，不另起状态表。
- **Bad**：为图省事把「查请求有效 → 调上游 → 无条件 markVerified」当完成路径。

### 6. Tests Required

- initData：独立固定向量（独立脚本/独立签名助手生成，**禁止被测函数自签自验**），
  覆盖错误 token、篡改 user、含 signature、300/301 秒与 +30/+31 秒边界。
- 栅栏：并发恰一胜、ban→unban、删除后旧请求 404 且不重建、失败清理不误删新请求。
- 路由：错误码矩阵全分支；`/health` 字节级回归（`test/health.test.ts` 守卫）。
- selfcheck：官方测试密钥（含 invisible 变体 `…BB`）逐一点名且不回显完整值。

### 7. Wrong vs Correct

#### Wrong

```ts
const ok = await checkRequestValid(...);   // 读判
await siteverify(token);                  // await 窗口内状态可能已变
await markVerified(userId);               // 无条件写 —— 竞态放行
```

#### Correct

```ts
const won = await completeTurnstileVerification(cas); // 单条条件 UPDATE 裁决
if (!won) return respond(409);          // meta.changes===1 才有成功副作用
```

---

## 相关规范

- [数据库（D1）](./database.md) — settings 快照/事务化切换与 users 栅栏列语义
- [错误处理](./error-handling.md) — Telegram 三态结果与通知失败边界
- [观测端点](./observability.md) — selfcheck 的 Turnstile 配置检查
