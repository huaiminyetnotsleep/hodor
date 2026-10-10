/**
 * 验证请求标识（Turnstile 任务）：nonce 生成 / 摘要与格式校验。
 *
 * 契约：
 * - 原始标识 nonce = crypto.getRandomValues 生成的 32 随机字节，编码为
 *   64 个小写十六进制字符；URL（GET /verify?r=…）与提交体携带**原值**；
 * - D1 永远只存 SHA-256 摘要（users.verify_request_hash）——库泄漏不等于
 *   可用链接，日志 / 诊断也只允许出现摘要；
 * - 请求自创建起 600 秒有效；有效期按创建时间计算，页面打开 / token 刷新 /
 *   重试一律不得延长（expires_at <= now 即过期）。
 *
 * 三模式共用：math / button 也走同一预留 → 发送 → 回填栅栏（不新增题目
 * 超时，expiresAt 传 null）；Turnstile 才携带 600 秒到期时间。
 */

/** Turnstile 请求有效期：创建 + 600 秒 */
export const VERIFY_REQUEST_TTL_MS = 600_000;

/** nonce 字节数（→ 64 个十六进制字符） */
const NONCE_BYTES = 32;

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** SHA-256 十六进制摘要（小写；用于 verify_request_hash 的唯一写入口） */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** nonce 格式校验：恰好 64 个小写十六进制字符（GET /verify 与提交体共用） */
export function isVerifyNonceFormat(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export interface VerifyRequestIdentity {
  /** 原始随机标识：只进 URL / 提交体，绝不落库、绝不写日志 */
  nonce: string;
  /** SHA-256(nonce)：D1 users.verify_request_hash 唯一允许存储的形态 */
  hash: string;
  /** 到期时间（ISO-8601 UTC 文本）；math / button 题目不携带（null = 无超时） */
  expiresAt: string | null;
}

/**
 * 生成一份新请求标识（Turnstile 用；ttlMs 传 null 表示不设到期——math /
 * button 模式的统一栅栏预留）。
 */
export async function createVerifyRequest(now: Date, ttlMs: number | null): Promise<VerifyRequestIdentity> {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  const nonce = bytesToHex(bytes);
  return {
    nonce,
    hash: await sha256Hex(nonce),
    expiresAt: ttlMs === null ? null : new Date(now.getTime() + ttlMs).toISOString(),
  };
}
