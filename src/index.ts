// 路由层：极薄分发，只回答「这个请求交给谁」（分层约定见 docs/guide/architecture.md）
import { handleHealth } from "./routes/health";

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return handleHealth();
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
