import { defineConfig } from 'vitest/config';
import { cloudflarePool, cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// vitest-pool-workers 0.22（配 Vitest 4）需要两个挂点：
//   1. cloudflareTest(options)：Vite 插件，解析 cloudflare:test 虚拟模块并外部化 workerd 内建
//   2. test.poolRunner = cloudflarePool(options)：自定义 pool（注册名固定 'cloudflare-pool'）
// wrangler.jsonc 提供绑定来源（D1 binding DB、main=src/index.ts）。
// migrations 在 Node 侧读出（workerd 沙箱读不了磁盘），经 bindings 注入后由测试内 applyD1Migrations 执行。
export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations/', import.meta.url).pathname);
  const workers = {
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: migrations,
        // S9：管理端点经 env 取 Secret/配置，测试必须不依赖本地 .dev.vars（真值不入库、
        // CI 无此文件）——注入确定测试值（全为假值，仅测试隔离用），miniflare bindings
        // 覆盖 wrangler 配置加载的 dev vars。
        TELEGRAM_BOT_TOKEN: 'test-bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
        ADMIN_SETUP_SECRET: 'test-admin-secret',
        SUPPORT_CHAT_ID: '-1001234567890',
        ADMIN_IDS: '111111111,222222222',
        ALLOW_UNKNOWN_USERS: 'true',
        MAX_ATTEMPTS: '8',
      },
    },
  };

  return {
    plugins: [cloudflareTest(workers)],
    test: {
      pool: 'cloudflare-pool',
      poolRunner: cloudflarePool(workers),
    },
  };
});
