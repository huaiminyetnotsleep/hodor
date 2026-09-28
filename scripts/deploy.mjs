#!/usr/bin/env node
/**
 * 显式部署入口（npm run deploy）：置备（复用/创建 D1 + 注入 id + 幂等迁移）后执行 wrangler deploy。
 * 与 postinstall 自动置备（scripts/provision.mjs --best-effort）共用同一套逻辑。
 */
import { ensureDatabase, injectDatabaseId, runLive, runMigrations } from './provision.mjs';

const uuid = ensureDatabase();
injectDatabaseId(uuid, { allowWrite: true });
runMigrations();
runLive('npx wrangler deploy');
