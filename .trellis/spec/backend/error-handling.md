# Error Handling — Telegram Tri-State Language

> How all Telegram API errors are classified and consumed. Established in S2 (2026-09-28).

---

## Convention: TelegramResult is the only error language for pipeline code

**What**: `src/telegram/types.ts` defines `TelegramResult<T> = TelegramOk<T> | TelegramError`,
where `TelegramError.kind` is `'retryable' | 'permanent'` (optional `retryAfterSeconds`,
`errorMessage`). HTTP/JSON details are classified **inside** `src/telegram/client.ts` (`request()`);
pipeline modules (S3+) never see status codes — they branch on `kind` only.

**Why**: keeps docs/03's rule that S5 branches 403 into `bot_blocked_by_user` without string
sniffing HTTP layers; one classification point, testable in isolation.

### Classification matrix (verbatim from design.md decision table)

| Telegram response | Kind | Extra semantics |
|---|---|---|
| 200 + `ok:true` | Ok | passthrough result |
| 200 + `ok:false` | permanent | errorMessage = description |
| 429, `retry_after ≤ 3s` | **in-place retry exactly once** (setTimeout) | still 429 → retryable with new value; never retry twice |
| 429, `retry_after > 3s` / missing | retryable | upstream re-throw → inbox 5xx → Telegram redelivery |
| 403 | permanent | caller (S5) drives `bot_blocked_by_user` |
| 400 | permanent (poison pill) | never retried |
| 5xx / network error / non-JSON | retryable | |
| other 4xx | permanent | conservative default |

### Consumer rules (S3+)

- `retryable` → let the request fail (5xx) so the inbox state machine + Telegram redelivery retry;
  never loop inside pipeline code.
- `permanent` → decide per docs/03: mark `processed` (poison pill / blocked user), never 5xx.
- Do not add new classification branches outside `client.ts`.

## Tests required

- Classification matrix + both 429 paths with call-count assertions (test/telegram-client.test.ts).
- Consumers (S3+): each `kind` branch asserts the resulting inbox status / HTTP response.

## Known follow-ups (recorded in task PRDs)

- S5 decision: whether `permanent` gains `errorCode?: number` (replace future string sniffing for 403).
- S3: add the missing case "200 + valid JSON without `ok` field → retryable".
