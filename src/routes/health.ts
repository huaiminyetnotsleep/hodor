import { APP_VERSION } from '../version';

/**
 * GET /health — 健康检查（docs/09 安全清单）。
 * 只回版本与存活；响应体即为全部内容，不泄露任何配置或 Secret。
 */
export function handleHealth(): Response {
  return Response.json({ ok: true, version: APP_VERSION });
}
