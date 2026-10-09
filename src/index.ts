// 路由层：极薄分发，只回答「这个请求交给谁」（分层约定见 docs/guide/architecture.md）
import { handleDeleteWebhook, handleSetWebhook, parseAdminPath } from "./routes/admin";
import { handleHealth, handleSelfCheck } from "./routes/health";
import { handleVerifyPage, handleVerifySubmit } from "./routes/verify";
import { handleWebhook } from "./routes/webhook";

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") return handleHealth();

    // 完整自检（T07，阶段 7）：公开只读（与 /health 同无鉴权），逐项检查
    // env / 验证配置 / 八表 / webhook 绑定；非 GET 自然落 404（极薄路由，逻辑在 routes 层）
    if (request.method === "GET" && pathname === "/selfcheck") {
      return handleSelfCheck(request, env);
    }

    // Turnstile 验证页面（2026-10-09 任务）：Mini App 入口（web_app 按钮）与
    // 唯一完成 API。GET /verify?r=<nonce> 只发安全静态页面；POST 提交身份 +
    // token，全部校验在 routes/verify 层。非约定方法自然落 404。
    if (request.method === "GET" && pathname === "/verify") {
      return handleVerifyPage(request, env);
    }
    if (request.method === "POST" && pathname === "/api/verify/turnstile") {
      return handleVerifySubmit(request, env);
    }

    // 管理端点：GET /setwebhook/<ADMIN_SECRET>、GET /deletewebhook/<ADMIN_SECRET>
    // 段数 / 前缀 / 编码不合法 → null → 落到 404；密钥正误由 admin 层统一 401
    if (request.method === "GET") {
      const admin = parseAdminPath(pathname);
      if (admin) {
        return admin.action === "setwebhook"
          ? handleSetWebhook(request, env, admin.secret)
          : handleDeleteWebhook(env, admin.secret);
      }
    }

    // Telegram update 唯一入口：头校验 → 幂等认领 → classify 派发（全部在 webhook 路由内）
    if (request.method === "POST" && pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
