#!/usr/bin/env node
/**
 * 置备：确保 D1 存在 → 把真实 database_id 注入【构建工作区】的 wrangler.jsonc（绝不回写仓库）→ 幂等迁移。
 *
 * CLI 用法：
 *   node scripts/provision.mjs                # 严格模式：失败即退出非零（构建命令/手动用）
 *   node scripts/provision.mjs --best-effort  # 宽松模式：失败仅告警（package.json postinstall 用）
 *
 * 护栏：
 *   - --best-effort 且非 CI 环境（本地 npm install）→ 直接跳过，不触碰 CF 账号；
 *   - 未认证/令牌无权限 → 告警退出，不阻塞安装；部署命令可在面板改用 `npm run deploy` 兜底；
 *   - D1_DATABASE_ID 环境变量可跳过探测/创建（逃生舱）。
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export const DB_NAME = 'hodor';
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

export const runOut = (cmd) =>
  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
export const runLive = (cmd) => execSync(cmd, { stdio: 'inherit' });

export function findDatabase() {
  try {
    const list = JSON.parse(runOut('npx wrangler d1 list --json'));
    return Array.isArray(list) ? list.find((d) => d.name === DB_NAME) : undefined;
  } catch {
    return undefined; // 未认证等场景：调用方按"不存在"处理并给出告警
  }
}

export function ensureDatabase() {
  if (process.env.D1_DATABASE_ID?.trim()) {
    const uuid = process.env.D1_DATABASE_ID.trim();
    console.log(`使用环境变量 D1_DATABASE_ID 指定的数据库 (${uuid})`);
    return uuid;
  }
  let db = findDatabase();
  if (!db) {
    console.log(`D1 "${DB_NAME}" 不存在，创建中…`);
    try {
      runLive(`npx wrangler d1 create ${DB_NAME}`);
    } catch {
      throw new Error(
        `创建 D1 "${DB_NAME}" 失败（未登录或令牌无建库权限）。` +
          `可在面板 Storage & Databases 建同名库后重试，或设 D1_DATABASE_ID。`,
      );
    }
    db = findDatabase();
  }
  if (!db?.uuid) throw new Error(`无法取得 D1 "${DB_NAME}" 的 database_id`);
  console.log(`使用 D1: ${DB_NAME} (${db.uuid})`);
  return db.uuid;
}

export function injectDatabaseId(uuid, { allowWrite = true } = {}) {
  const path = 'wrangler.jsonc';
  const config = readFileSync(path, 'utf8');
  if (config.includes(uuid)) return;
  if (!config.includes(PLACEHOLDER)) {
    throw new Error(`${path} 中既无占位 database_id 也无当前 id，请检查仓库状态`);
  }
  if (!allowWrite) {
    console.log('非 CI 环境：跳过配置注入（仅部署构建需要）');
    return;
  }
  writeFileSync(path, config.replace(PLACEHOLDER, uuid));
  console.log(`已向构建工作区的 ${path} 注入 database_id（不回写仓库）`);
}

export function runMigrations() {
  runLive(`npx wrangler d1 migrations apply ${DB_NAME} --remote`);
}

const bestEffort = process.argv.includes('--best-effort');
if (bestEffort && !process.env.CI) {
  console.log('[provision] 非 CI 环境，跳过置备');
} else {
  try {
    const uuid = ensureDatabase();
    injectDatabaseId(uuid, { allowWrite: !bestEffort || Boolean(process.env.CI) });
    runMigrations();
  } catch (err) {
    if (bestEffort) {
      console.warn(`[provision] 跳过置备：${err.message}`);
    } else {
      throw err;
    }
  }
}
