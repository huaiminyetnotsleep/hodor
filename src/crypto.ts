/**
 * crypto · Webhook Secret / Admin Secret 校验共用原语（docs/05「Secret 校验实现」）。
 * 数据面（webhook/router）与管理面（admin/router）同一模式：SHA-256 后常量时间比较。
 */

/** SHA-256 十六进制小写（与 bots.webhook_secret_hash 的存储格式一致，docs/05） */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 常量时间比较：长度相同逐位 XOR 累积，全部相同才返回 true（防时序侧信道，docs/05）。
 * 长度不同直接 false——哈希长度本身不是机密（定长 64 hex）。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
