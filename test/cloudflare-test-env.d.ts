import type { D1Migration } from 'cloudflare:test';

// 测试专用绑定：vitest.config.ts 经 miniflare bindings 注入的 D1 迁移清单
// （readD1Migrations 读出的结构化迁移）。生产 Env 不含此字段。
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
