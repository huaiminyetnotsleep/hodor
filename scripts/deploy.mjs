#!/usr/bin/env node
/**
 * 零改动部署（Workers Builds 的部署命令保持默认 `npm run deploy` 即可）：
 *   1. 按名字复用账号下已有的 D1；不存在则创建；
 *   2. 把真实 database_id 写进【构建工作区】的 wrangler.jsonc——绝不回写仓库，
 *      仓库中的占位符 00000000-… 永久保留；
 *   3. 幂等执行迁移；4. 部署。
 * 若构建令牌无建库权限：在面板建好同名 D1 再重跑，脚本会按名字复用。
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DB_NAME = 'hodor';
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

const runOut = (cmd) =>
  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const runLive = (cmd) => execSync(cmd, { stdio: 'inherit' });

function findDatabase() {
  try {
    const list = JSON.parse(runOut('npx wrangler d1 list --json'));
    return Array.isArray(list) ? list.find((d) => d.name === DB_NAME) : undefined;
  } catch {
    return undefined;
  }
}

let db = findDatabase();
if (!db) {
  console.log(`D1 "${DB_NAME}" 不存在，创建中…`);
  runLive(`npx wrangler d1 create ${DB_NAME}`);
  db = findDatabase();
}
if (!db?.uuid) throw new Error(`无法取得 D1 "${DB_NAME}" 的 database_id`);
console.log(`使用 D1: ${DB_NAME} (${db.uuid})`);

const configPath = 'wrangler.jsonc';
const config = readFileSync(configPath, 'utf8');
if (!config.includes(db.uuid)) {
  if (!config.includes(PLACEHOLDER)) {
    throw new Error(`${configPath} 中既无占位 database_id 也无当前 id，请检查仓库状态`);
  }
  writeFileSync(configPath, config.replace(PLACEHOLDER, db.uuid));
  console.log(`已向构建工作区的 ${configPath} 注入 database_id（不回写仓库）`);
}

runLive(`npx wrangler d1 migrations apply ${DB_NAME} --remote`);
runLive('npx wrangler deploy');
