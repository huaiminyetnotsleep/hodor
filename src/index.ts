import { handleAdmin } from './admin';
import { handleHealth } from './routes/health';
import { handleTelegramWebhook } from './webhook';
import type { Env } from './types';

/**
 * Worker 入口（docs/05「Worker 路由总览」）：
 *   GET  /health                          → 健康检查（唯一 GET，验活）
 *   POST /telegram/webhook/:webhook_key   → 消息管线（S3）
 *   POST /admin/*                         → 管理端点（S9：setup/status/unbind/admins，POST only）
 * 其余路径一律 404。
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return handleHealth();
    }

    if (url.pathname.startsWith('/telegram/webhook/')) {
      return handleTelegramWebhook(request, env);
    }

    if (url.pathname.startsWith('/admin/')) {
      return handleAdmin(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  },
};
