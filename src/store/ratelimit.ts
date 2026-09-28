/**
 * store · 管理端基础限速（S9，docs/05「管理端凭证」：端点做基础限速防探测）。
 *
 * 固定窗口计数：内存 Map<key, {count, windowStart}>，isolate 级单例（模块级 Map）——
 * 管理端操作低频（docs/05），跨 isolate 间独立计数即可接受，不引入 Durable Object。
 * 命中窗口上限返回 false，由 admin/router 转 429。
 */

/** 窗口长度（毫秒）；常量可调 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** 窗口内允许的最大请求数；常量可调 */
export const RATE_LIMIT_MAX_REQUESTS = 10;

interface Bucket {
  count: number;
  windowStart: number;
}

/** isolate 级单例：key（CF-Connecting-IP 等）→ 当前窗口计数 */
const buckets = new Map<string, Bucket>();

/**
 * 记一次请求并判断是否放行。窗口内第 n 次请求：n ≤ 上限放行，超限拒绝（计数继续累积，
 * 便于观测探测强度）。窗口过期则重开新窗口。
 */
export function checkRateLimit(key: string, now: number = Date.now()): boolean {
  const bucket = buckets.get(key);
  if (bucket === undefined || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX_REQUESTS;
}

/**
 * 清空全部计数——仅供测试隔离使用（限速是 isolate 级内存态，测试间必须重置，
 * 否则用例间共享窗口互相污染；docs/10：测试辅助不进入业务路径）。
 */
export function resetRateLimitForTests(): void {
  buckets.clear();
}
