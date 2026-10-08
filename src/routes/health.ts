/**
 * GET /health — 部署存活探针（基础版）。
 * version 由构建时从 package.json 注入（src/generated/version.ts，T08），
 * 形状对齐 docs/guide/architecture.md；完整自检（环境变量 / 各表 / webhook
 * 绑定）是阶段 7 范围。
 */
import { VERSION } from "../generated/version";

export function handleHealth(): Response {
  return Response.json({ status: "ok", version: VERSION });
}
