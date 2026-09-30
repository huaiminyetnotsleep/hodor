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
    // 注入确定性测试变量：miniflare bindings 未覆盖的变量会从本地 .dev.vars
    // 泄漏进来（不同机器结果不同），因此全部显式钉死；缺省分支的确定性由
    // env.test.ts 用构造 env 对象覆盖，而非依赖此处缺省
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: migrations,
        TELEGRAM_BOT_TOKEN: "test-bot-token",
        TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
        ADMIN_SECRET: "test-admin-secret",
        SUPPORT_CHAT_ID: "-1001234567890",
        ADMIN_IDS: "111111111,222222222",
        MAX_ATTEMPTS: "3",
        // 阶段 3 起入站欢迎语读取该变量：钉死为空 → 各用例统一走默认文案
        // 兜底分支；自定义文案分支用构造 env 对象覆盖（env.test.ts 同模式）
        WELCOME_TEXT: "",
      },
    },
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
