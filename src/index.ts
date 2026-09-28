import { handleHealth } from './routes/health';
import type { Env } from './types';

/**
 * Worker 入口：Phase 1 仅 /health；S3 起挂载 POST /telegram/webhook/:webhook_key
 * 与 /admin/* 端点（docs/05 Worker 路由总览）。唯一 GET 是 /health。
 */
export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return handleHealth();
    }

    return new Response('Not Found', { status: 404 });
  },
};
