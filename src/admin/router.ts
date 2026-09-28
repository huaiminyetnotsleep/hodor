/**
 * admin · POST /admin/* 管理面路由（S9，docs/05「Worker 路由总览」、docs/09 安全清单）。
 *
 * 编排顺序：POST only（唯一 GET 是 /health，docs/05「参数为什么不放进 URL」）
 *   → 限速（固定窗口按 CF-Connecting-IP 计数，**先于鉴权**——防探测必须统计未授权尝试，
 *     docs/05「基础限速防探测」；超限 429）
 *   → Bearer 鉴权（Authorization: Bearer ADMIN_SETUP_SECRET，SHA-256 后常量时间比较，
 *     模式同 webhook Secret 校验；失败 401，零业务写入、零业务日志，docs/09）
 *   → 按 pathname 精确分发到子处理器。
 *
 * **参数永不进 URL**：全部端点 POST + JSON body（docs/05 安全约定，不做变通）。
 */
import { sha256Hex, timingSafeEqual } from '../crypto';
import { checkRateLimit } from '../store/ratelimit';
import type { Env } from '../types';
import { jsonError } from '../http';
import { handleAdmins } from './admins';
import { handleSetup } from './setup';
import { handleWebhookStatus, handleWebhookUnbind } from './webhook';

/** 子处理器统一签名：可读 URL（origin/pathname），参数只从 JSON body 取（docs/05） */
export type AdminSubHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const BEARER_PREFIX = 'Bearer ';
const RATE_LIMIT_KEY_HEADER = 'cf-connecting-ip';
const RATE_LIMIT_KEY_FALLBACK = 'unknown';

/** 路由表：pathname → 子处理器（精确匹配；未列出的一律 404） */
const routes: ReadonlyMap<string, AdminSubHandler> = new Map([
  ['/admin/setup', handleSetup],
  ['/admin/webhook/status', handleWebhookStatus],
  ['/admin/webhook/unbind', handleWebhookUnbind],
  ['/admin/admins', handleAdmins],
]);

export async function handleAdmin(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== 'POST') {
    return jsonError(404, 'not found'); // /health 是唯一 GET（docs/05 路由总览）
  }

  // 限速在鉴权之前：未授权的探测尝试同样占窗口（docs/05 基础防探测）
  const rateKey = request.headers.get(RATE_LIMIT_KEY_HEADER) ?? RATE_LIMIT_KEY_FALLBACK;
  if (!checkRateLimit(rateKey)) {
    return jsonError(429, 'too many requests');
  }

  // Bearer 鉴权：SHA-256 后常量时间比较（docs/05；失败零业务处理、零业务日志）
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith(BEARER_PREFIX) ? authorization.slice(BEARER_PREFIX.length) : '';
  const expected = await sha256Hex(env.ADMIN_SETUP_SECRET);
  if (token.length === 0 || !timingSafeEqual(await sha256Hex(token), expected)) {
    return jsonError(401, 'unauthorized');
  }

  const handler = routes.get(url.pathname);
  if (handler === undefined) {
    return jsonError(404, 'not found');
  }
  return handler(request, env, ctx);
}
