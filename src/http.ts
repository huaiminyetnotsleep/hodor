/**
 * http · 路由层共用小件（判空守卫与管理端 JSON 响应约定）。
 * isRecord 原为 webhook/router 私有守卫，admin 端 body 解析同样需要——按 code-reuse
 * 指南提取共享（2+ 消费方即提取，避免契约逻辑漂移）。
 */

/** JSON 解析结果的记录守卫（数组/标量不算 record） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 管理端成功响应：{ ok: true, ...data }（docs/05 端点即运维接口，JSON 全程） */
export function jsonOk(data: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...data });
}

/**
 * 管理端失败响应：{ ok: false, error }。错误说明可携带上游 errorMessage
 * （不含 Token/Secret 值，docs/06 硬约束）。
 */
export function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}
