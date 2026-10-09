/**
 * Telegram Mini App initData 校验（Turnstile 任务；design.md §5）。
 *
 * 唯一按官方 Bot Token HMAC 规则实现的模块：
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * - data-check-string：**排除 hash**，其余收到的字段（含可能存在的 signature）
 *   按字段名排序，以 `key=value` 形式用 LF（\n）拼接；字段值用 URL 解码后的
 *   原文（user 保持其 JSON 原文，绝不重新序列化 / 二次解码）。
 * - secret_key = HMAC-SHA256(key="WebAppData", message=botToken)，**保持二进制**；
 *   hash = HMAC-SHA256(key=secret_key, message=data-check-string) 的十六进制，
 *   与收到的 hash 做常量时间比较（长度合法 + 逐位异或）。
 * - 第三方 Ed25519 验证的字段排除规则（排除 hash 与 signature）**不适用**于
 *   本路径——signature 若存在按 HMAC 规则一并参与 data-check-string。
 * - HMAC 通过后才解析 user JSON（id 必须是正的安全整数），再检查 auth_date
 *   窗口：now - authDate ≤ 300 秒，且至多允许 30 秒未来时钟偏差。
 *
 * 输入边界（design §5「有界参数解析」）：总长 ≤ 8 KiB、字段数 ≤ 64、拒绝
 * 重复键、缺字段、畸形百分号编码；任何失败都不发起网络请求。
 */

/** initData 最大接受年龄（秒）：超过即要求关闭页面从 Bot 按钮重开 */
export const INITDATA_MAX_AGE_SECONDS = 300;
/** 允许的未来时钟偏差（秒）：auth_date 略超当前时间仍在容忍范围内 */
export const INITDATA_MAX_FUTURE_SKEW_SECONDS = 30;
/** 原始输入总长上限（UTF-8 字节） */
const MAX_INPUT_BYTES = 8 * 1024;
/** 字段数上限（Telegram initData 实际约 10 个字段；64 已远超必要） */
const MAX_FIELDS = 64;

export type TelegramInitDataFailure =
  | "format" /** 解析失败 / 超限 / 重复键 / 缺必填字段 / 编码异常 */
  | "signature" /** HMAC 校验失败（数据不是 Telegram 或被篡改） */
  | "expired"; /** auth_date 超出接受窗口 */

export type TelegramInitDataResult =
  | { ok: true; userId: number; authDate: number }
  | { ok: false; reason: TelegramInitDataFailure };

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** 常量时间十六进制串比较：长度不同直接 false；等长时逐位异或累计 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 单次解析查询串：拒绝空段、无 = 段、畸形编码与重复键（+ 按 %20 解码） */
function parseInitDataPairs(input: string): [string, string][] | null {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const part of input.split("&")) {
    if (part === "") return null;
    const eq = part.indexOf("=");
    if (eq === -1) return null;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(part.slice(0, eq).replace(/\+/g, "%20"));
      value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, "%20"));
    } catch {
      return null; // 畸形百分号编码
    }
    if (seen.has(key)) return null; // 重复键：身份校验绝不猜语义
    seen.add(key);
    pairs.push([key, value]);
  }
  return pairs.length > 0 ? pairs : null;
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, message);
}

export interface ValidateInitDataOptions {
  maxAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
}

/** now 用毫秒时间戳注入（调用方传 Date.now()，测试可拨时钟） */
export async function validateTelegramInitData(
  initData: string,
  botToken: string,
  now: number,
  options: ValidateInitDataOptions = {},
): Promise<TelegramInitDataResult> {
  const maxAge = options.maxAgeSeconds ?? INITDATA_MAX_AGE_SECONDS;
  const maxSkew = options.maxFutureSkewSeconds ?? INITDATA_MAX_FUTURE_SKEW_SECONDS;

  if (typeof initData !== "string" || initData.length === 0) return { ok: false, reason: "format" };
  if (new TextEncoder().encode(initData).byteLength > MAX_INPUT_BYTES) {
    return { ok: false, reason: "format" };
  }

  const pairs = parseInitDataPairs(initData);
  if (pairs === null || pairs.length > MAX_FIELDS) return { ok: false, reason: "format" };

  const fields = new Map(pairs);
  const hash = fields.get("hash");
  const authDateRaw = fields.get("auth_date");
  const userRaw = fields.get("user");
  if (hash === undefined || authDateRaw === undefined || userRaw === undefined) {
    return { ok: false, reason: "format" };
  }

  // data-check-string：排除 hash，其余字段按名排序、LF 拼接（解码后原值）
  const dataCheckString = pairs
    .filter(([key]) => key !== "hash")
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const encoder = new TextEncoder();
  // key1 = HMAC("WebAppData", botToken) —— 保持二进制，绝不先转 hex
  const secretKey = await hmacSha256(encoder.encode("WebAppData"), encoder.encode(botToken));
  const digest = bytesToHex(new Uint8Array(await hmacSha256(secretKey, encoder.encode(dataCheckString))));
  if (!timingSafeEqualHex(digest, hash)) return { ok: false, reason: "signature" };

  // 身份确认后才解析 user JSON：id 必须是正的安全整数
  let user: unknown;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "format" };
  }
  const userId =
    typeof user === "object" && user !== null ? (user as { id?: unknown }).id : undefined;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) {
    return { ok: false, reason: "format" };
  }

  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate)) return { ok: false, reason: "format" };
  const nowSeconds = Math.floor(now / 1000);
  // 未来超出偏差 → 拒绝（伪造 / 时钟异常）；过去超过窗口 → 过期（须重开）
  if (authDate > nowSeconds + maxSkew || nowSeconds - authDate > maxAge) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, userId, authDate };
}
