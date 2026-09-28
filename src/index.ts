import { handleHealth } from './routes/health';
import { handleTelegramWebhook } from './webhook';
import type { Env } from './types';

/**
 * Worker 入口：GET /health（唯一 GET，验活）+ POST /telegram/webhook/:webhook_key（S3，
 * docs/05 Worker 路由总览）。其余路径一律 404。/admin/* 端点在 S9 挂载。
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return handleHealth();
    }

    if (url.pathname.startsWith('/telegram/webhook/')) {
      return handleTelegramWebhook(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};
