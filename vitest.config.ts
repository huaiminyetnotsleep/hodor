// vitest-pool-workers 0.22 + Vitest 4 固定接线，见 .trellis/spec/backend/testing.md
// （0.22 起 defineWorkersConfig 已移除，必须用 cloudflareTest 插件 + cloudflarePool 双钩子）
import { defineConfig } from "vitest/config";
import {
  cloudflarePool,
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  // 迁移文件在 Node 侧读取（workerd 沙箱内没有 node:fs），
  // 经 miniflare bindings.TEST_MIGRATIONS 注入，测试内用 applyD1Migrations 应用
  const migrations = await readD1Migrations(
    new URL("./migrations/", import.meta.url).pathname,
  );
  const workers = {
    // 绑定来源：wrangler.jsonc（HODOR_DB 等）
    wrangler: { configPath: "./wrangler.jsonc" },
    // 本阶段不注入任何假环境变量（阶段 1 不读 env）
    miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
  };
  return {
    // cloudflareTest：Vitest 插件，提供 cloudflare:test 虚拟模块
    plugins: [cloudflareTest(workers)],
    test: {
      // 必须与 cloudflarePool(workers).name 相等，否则 Runner … is not supported
      pool: "cloudflare-pool",
      // cloudflarePool：注册 pool 运行时（测试在 workerd 里执行）
      poolRunner: cloudflarePool(workers),
    },
  };
});
