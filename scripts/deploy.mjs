#!/usr/bin/env node
// scripts/deploy.mjs —— 单命令部署编排（T05/T06 提前交付，2026-09-30 范围变更）
//
// 默认流程：注入版本模块 → 解析/创建 D1 数据库 → 应用远端迁移 → 部署 Worker。
//
// 核心不变量：
//   1. 仓库 wrangler.jsonc 一字不改：真实 database_id 只写入
//      .wrangler/resolved.wrangler.jsonc（.wrangler/ 已 gitignore），
//      migrate / deploy 均通过 --config 指向该临时配置。
//   2. 迁移失败 → 中止且不部署（T06 契约：不发布不兼容代码），修复后重跑即可。
//   3. 日志纪律：本脚本只输出步骤前缀、命令名、退出码与数据库 uuid（uuid 非
//      密钥，全量打印便于排障）。除 D1_DATABASE_ID 的取值外，脚本不读取任何
//      其他环境变量的内容，任何路径下都不回显凭据；wrangler 自身的输出（含
//      报错）通过 stdio 直接透传，不经过本脚本的日志。
//
// wrangler 调用策略：直接以 process.execPath（即当前 node）执行仓库本地的
// node_modules/.bin/wrangler 入口，spawn cwd 固定为仓库根目录。不选
// `npx --no-install wrangler`：npx 有额外的解析/启动开销，且在离线或镜像环境
// 下存在回退安装等不受控行为；.bin 直接路径零歧义（本仓库用 npm 安装，
// .bin/wrangler 是指向 wrangler/bin/wrangler.js 的符号链接，node 可直接执行）。
// 注意：.bin 直启假定类 Unix 平台（macOS / Linux，含 Workers Builds）。
//
// 纯函数（JSONC 剥注释解析 / database_id 原地替换）在 scripts/lib/config.mjs，
// 版本模块纯渲染/校验在 scripts/lib/version.mjs——两者均可被 workerd 沙箱内的
// 测试导入；本文件只做进程与文件编排，不被测试导入。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLACEHOLDER_DATABASE_ID,
  parseWranglerConfig,
  replaceJsoncString,
  withDatabaseId,
} from "./lib/config.mjs";
import { renderVersionModule } from "./lib/version.mjs";

// —— 路径常量：全部基于 import.meta.url 推导，与进程 cwd 无关 ——
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_CONFIG_PATH = path.join(REPO_ROOT, "wrangler.jsonc");
const RESOLVED_CONFIG_DIR = path.join(REPO_ROOT, ".wrangler");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const VERSION_MODULE_PATH = path.join(REPO_ROOT, "src", "generated", "version.ts");

/**
 * resolved 临时配置的绝对路径（真实 database_id 的唯一落点，已 gitignore）。
 * @type {string}
 */
export const RESOLVED_CONFIG_PATH = path.join(
  RESOLVED_CONFIG_DIR,
  "resolved.wrangler.jsonc",
);

const WRANGLER_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "wrangler");

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
// 认证/权限类失败特征（对 wrangler 报错文本做分类用）
const AUTH_FAILURE_PATTERN =
  /authentic|unauthori[sz]ed|not authorized|forbidden|\b403\b|api token|oauth token|not logged in|wrangler login/i;
// 数据库不存在特征
const NOT_FOUND_PATTERN =
  /not found|couldn'?t find|could not find|does ?n[o']t exist|no such/i;
// 未知参数特征（个别 wrangler 版本的子命令不支持 --json）
const UNKNOWN_FLAG_PATTERN =
  /unknown (?:argument|option|flag)|unexpected argument|unrecognized/i;
// 同名库已被（并发）创建特征
const ALREADY_EXISTS_PATTERN = /already exist/i;

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

/**
 * 打印简短中文用法。--help 是纯本地旗标：在读取配置、检查 wrangler、发起任何
 * wrangler 调用之前短路返回。
 */
function printUsage() {
  console.log(`用法：npm run deploy [--provision-only | --migrate-only]

模式：
  （默认）           注入版本模块 → 解析/创建 D1 数据库 → 应用远端迁移 → 部署 Worker
  --provision-only   只解析/创建数据库并写出 resolved 配置（不迁移、不部署、不注入版本）
  --migrate-only     注入版本模块 → 解析数据库 + 应用远端迁移（不部署）
  --help, -h         显示本帮助

环境变量：
  D1_DATABASE_ID     可选。直接指定数据库 uuid，跳过 wrangler 查询/创建
                     （构建环境 token 无 D1 查询/创建权限时的逃生口）`);
}

/**
 * 解析命令行参数为运行模式。未知参数 / 位置参数 / 模式互斥冲突直接报错退出。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ mode: "default" | "provision-only" | "migrate-only" | "help" }}
 */
function parseArgs(argv) {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  if (flags.includes("--help") || flags.includes("-h")) {
    return { mode: "help" };
  }
  const known = new Set(["--provision-only", "--migrate-only"]);
  const unknown = flags.filter((flag) => !known.has(flag));
  if (positional.length > 0) {
    console.error(`不接受位置参数：${positional.join(" ")}`);
    printUsage();
    process.exit(1);
  }
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(" ")}`);
    printUsage();
    process.exit(1);
  }
  const modes = flags.filter((flag) => known.has(flag));
  if (modes.length > 1) {
    console.error("--provision-only 与 --migrate-only 不能同时使用。");
    printUsage();
    process.exit(1);
  }
  if (modes[0] === "--provision-only") {
    return { mode: "provision-only" };
  }
  if (modes[0] === "--migrate-only") {
    return { mode: "migrate-only" };
  }
  return { mode: "default" };
}

/**
 * 运行本地 wrangler CLI。
 *
 * stdout 可捕获（供 --json / 表格输出解析）；stderr 可「边转发边留底」：转发
 * 等价于 inherit（用户实时看到 wrangler 自身的报错），留底仅用于错误分类
 * （正则测试），脚本不把其内容写进任何日志。migrate / deploy 不需要分类，
 * 走完整 inherit。
 *
 * @param {string[]} args wrangler 子命令与参数
 * @param {{ captureStdout?: boolean, teeStderr?: boolean }} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runWrangler(args, { captureStdout = false, teeStderr = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRANGLER_BIN, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", captureStdout ? "pipe" : "inherit", teeStderr ? "pipe" : "inherit"],
    });
    let stdout = "";
    let stderr = "";
    if (captureStdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (teeStderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        process.stderr.write(chunk);
      });
    }
    child.on("error", (error) => {
      console.error(
        `[deploy] 无法启动 wrangler（${WRANGLER_BIN}）：${error.code ?? error.message}`,
      );
      process.exit(1);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * 从 wrangler --json 输出中提取 uuid 字段。输出可能是对象或单元素数组；也可能
 * 混有横幅文本，故整体 parse 失败时退化到截取首尾大括号之间的片段再试。
 *
 * @param {string} stdout
 * @returns {string | null}
 */
function extractUuidFromJsonOutput(stdout) {
  const trimmed = stdout.trim();
  const candidates = [];
  try {
    candidates.push(JSON.parse(trimmed));
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        candidates.push(JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)));
      } catch {
        // 放弃 JSON 路径，交给正则提取
      }
    }
  }
  for (const candidate of candidates) {
    const root = Array.isArray(candidate) ? candidate[0] : candidate;
    if (
      root !== null &&
      typeof root === "object" &&
      typeof root.uuid === "string" &&
      UUID_PATTERN.test(root.uuid)
    ) {
      return root.uuid;
    }
  }
  return null;
}

/**
 * 从任意文本（如 d1 create 的表格输出）中提取第一个 uuid。
 *
 * @param {string} text
 * @returns {string | null}
 */
function extractUuidByRegex(text) {
  return text.match(UUID_PATTERN)?.[0] ?? null;
}

/**
 * 认证/权限不足时的可操作引导（wrangler 的原始报错已实时透传给用户；
 * 这里只补下一步指引，不回显任何凭据）。
 *
 * @param {string} command 失败的 wrangler 命令名
 * @param {number} code 退出码
 */
function printPermissionGuidance(command, code) {
  console.error(
    `[provision] wrangler ${command} 失败（退出码 ${code}），疑似认证或权限不足。`,
  );
  console.error(
    "[provision] 请在 Cloudflare dashboard 创建具备 D1 编辑权限的自定义 API token 配置到构建环境" +
      "（环境变量 CLOUDFLARE_API_TOKEN），或手动创建数据库后将 uuid 设为 D1_DATABASE_ID 环境变量。",
  );
}

/**
 * 查询数据库 uuid。
 *
 * @param {string} databaseName
 * @returns {Promise<string | null>} uuid；数据库不存在返回 null；
 *   认证/权限类失败或其他非「不存在」错误直接中止进程。
 */
async function queryDatabaseUuid(databaseName) {
  let info = await runWrangler(["d1", "info", databaseName, "--json"], {
    captureStdout: true,
    teeStderr: true,
  });
  if (info.code !== 0 && UNKNOWN_FLAG_PATTERN.test(info.stdout + info.stderr)) {
    // wrangler 版本差异：d1 info 不认 --json → 去掉该参数重试，表格输出走正则提取
    info = await runWrangler(["d1", "info", databaseName], {
      captureStdout: true,
      teeStderr: true,
    });
  }
  if (info.code === 0) {
    const uuid =
      extractUuidFromJsonOutput(info.stdout) ?? extractUuidByRegex(info.stdout);
    if (uuid !== null) {
      return uuid;
    }
    if (NOT_FOUND_PATTERN.test(info.stdout + info.stderr)) {
      return null; // 个别版本对缺失库也可能退出 0：按不存在处理
    }
    console.error(
      "[provision] wrangler d1 info 退出码 0，但无法从输出中解析出 uuid，已中止。",
    );
    process.exit(1);
  }
  const output = info.stdout + info.stderr;
  if (AUTH_FAILURE_PATTERN.test(output) || !NOT_FOUND_PATTERN.test(output)) {
    // 非零退出且不是「数据库不存在」：按认证/权限类失败处理
    printPermissionGuidance(`d1 info ${databaseName}`, info.code);
    process.exit(1);
  }
  return null; // 数据库不存在
}

/**
 * 创建数据库并返回 uuid。
 *
 * d1 create 在当前 wrangler 版本不支持 --json（--help 可见）：先带 --json 尝试
 * （未来版本可能支持），报未知参数则去掉重试；成功输出统一「先 JSON、后正则」
 * 提取 uuid。
 *
 * @param {string} databaseName
 * @returns {Promise<string>}
 */
async function createDatabase(databaseName) {
  let created = await runWrangler(["d1", "create", databaseName, "--json"], {
    captureStdout: true,
    teeStderr: true,
  });
  if (created.code !== 0 && UNKNOWN_FLAG_PATTERN.test(created.stdout + created.stderr)) {
    created = await runWrangler(["d1", "create", databaseName], {
      captureStdout: true,
      teeStderr: true,
    });
  }
  if (created.code === 0) {
    const uuid =
      extractUuidFromJsonOutput(created.stdout) ?? extractUuidByRegex(created.stdout);
    if (uuid !== null) {
      log("provision", `已创建数据库 ${databaseName} ${uuid}`);
      return uuid;
    }
    console.error(
      "[provision] 数据库创建成功，但无法从 wrangler 输出中解析出 uuid，已中止。",
    );
    process.exit(1);
  }

  const output = created.stdout + created.stderr;
  // 并发竞态：另一个构建先创建了同名库 → 回查 info 复用，不重复建库
  if (ALREADY_EXISTS_PATTERN.test(output)) {
    const uuid = await queryDatabaseUuid(databaseName);
    if (uuid !== null) {
      log("provision", `数据库 ${databaseName} 已被并发创建，复用 ${uuid}`);
      return uuid;
    }
  }
  if (AUTH_FAILURE_PATTERN.test(output)) {
    printPermissionGuidance(`d1 create ${databaseName}`, created.code);
  } else {
    console.error(
      `[provision] 创建数据库失败（wrangler d1 create 退出码 ${created.code}），已中止。`,
    );
  }
  process.exit(1);
}

/**
 * 解析目标数据库 uuid。
 *
 * 顺序：D1_DATABASE_ID 环境变量（逃生口，跳过一切查询）→ wrangler d1 info
 * （存在则复用）→ wrangler d1 create（不存在则创建）。名称是唯一事实源：
 * 即便配置里已是非占位 id，仍按名称重新解析。
 *
 * @param {string} databaseName
 * @returns {Promise<{ uuid: string, source: "env" | "existing" | "created" }>}
 */
async function resolveDatabaseId(databaseName) {
  const fromEnv = (process.env.D1_DATABASE_ID ?? "").trim();
  if (fromEnv !== "") {
    if (!UUID_PATTERN.test(fromEnv)) {
      console.error(`[provision] D1_DATABASE_ID 不是合法的 uuid：${fromEnv}`);
      console.error(
        "[provision] 请填入 wrangler d1 info 输出中的数据库 uuid，或移除该变量改用自动解析。",
      );
      process.exit(1);
    }
    return { uuid: fromEnv, source: "env" };
  }

  const existing = await queryDatabaseUuid(databaseName);
  if (existing !== null) {
    return { uuid: existing, source: "existing" };
  }

  log("provision", `数据库 ${databaseName} 不存在，开始创建…`);
  const uuid = await createDatabase(databaseName);
  return { uuid, source: "created" };
}

/**
 * 生成 resolved 配置文本：写入真实 uuid，并把 main / migrations_dir 改写为
 * 仓库内绝对路径。
 *
 * 为什么要改写路径：wrangler 对 --config 指定的配置，其中的相对路径以「配置
 * 文件所在目录」为基准解析。resolved 配置位于 .wrangler/ 下，若保留
 * "src/index.ts" 与 "migrations" 原样，会被解析成 .wrangler/src/index.ts 与
 * .wrangler/migrations。改写为绝对路径后与解析基准无关，稳态指向仓库真实
 * 位置。若未来配置新增其他相对路径字段（如 assets.directory），需在此同步
 * 追加改写。
 *
 * @param {string} rawText 仓库 wrangler.jsonc 原文
 * @param {string} uuid 已解析的数据库 uuid
 * @returns {string} resolved 配置文本（注释保留）
 */
export function buildResolvedConfig(rawText, uuid) {
  const parsed = parseWranglerConfig(rawText);
  let resolved = withDatabaseId(rawText, uuid);
  if (typeof parsed.main === "string") {
    resolved = replaceJsoncString(resolved, "main", path.resolve(REPO_ROOT, parsed.main));
  }
  const migrationsDir = parsed?.d1_databases?.[0]?.migrations_dir;
  if (typeof migrationsDir === "string") {
    resolved = replaceJsoncString(
      resolved,
      "d1_databases[0].migrations_dir",
      path.resolve(REPO_ROOT, migrationsDir),
    );
  }
  return resolved;
}

/**
 * 生成 src/generated/version.ts（T08 版本注入）。
 *
 * 纯渲染/校验在 scripts/lib/version.mjs；本函数只做文件读写（与
 * scripts/gen-version.mjs 各自内联 fs，lib 保持无 node:* 导入以便 workerd
 * 沙箱测试导入）。内容不变则不写（保 mtime）。为什么不 spawn
 * `node scripts/gen-version.mjs`：本脚本已运行在 Node 中，直接复用同一渲染
 * 函数少一次进程启动，且与 npm 钩子路径行为完全一致。
 */
function generateVersionModule() {
  let version;
  try {
    version = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")).version;
  } catch {
    version = undefined;
  }
  if (typeof version !== "string" || version === "") {
    console.error(`[version] 无法从 ${PACKAGE_JSON_PATH} 读取可用的 version 字段，已中止。`);
    process.exit(1);
  }
  let content;
  try {
    content = renderVersionModule(version);
  } catch (error) {
    console.error(
      `[version] package.json 版本号非法（${version}）：${
        error instanceof Error ? error.message : String(error)
      }，已中止。`,
    );
    process.exit(1);
  }
  if (existsSync(VERSION_MODULE_PATH) && readFileSync(VERSION_MODULE_PATH, "utf8") === content) {
    log("version", `已是最新 src/generated/version.ts @ ${version}`);
    return;
  }
  mkdirSync(path.dirname(VERSION_MODULE_PATH), { recursive: true });
  writeFileSync(VERSION_MODULE_PATH, content, "utf8");
  log("version", `已生成 src/generated/version.ts @ ${version}`);
}

/**
 * 对远端数据库应用迁移；任何非零退出都中止且不部署（T06 契约）。
 * wrangler 输出走完整 inherit，用户能看到待应用/已应用的迁移清单。
 *
 * @param {string} databaseName
 */
async function applyMigrations(databaseName) {
  log("migrate", `应用远端迁移（数据库 ${databaseName}）…`);
  const result = await runWrangler([
    "d1",
    "migrations",
    "apply",
    databaseName,
    "--remote",
    "--config",
    RESOLVED_CONFIG_PATH,
  ]);
  if (result.code !== 0) {
    console.error(`[migrate] 迁移失败（退出码 ${result.code}）。`);
    console.error(
      "[migrate] 迁移失败，已中止部署（未发布不兼容代码）；修复后重新运行 npm run deploy 即可重试。",
    );
    process.exit(1);
  }
  log("migrate", "远端迁移完成。");
}

/**
 * 部署 Worker（使用 resolved 配置；wrangler 输出走完整 inherit，
 * 用户能看到部署 URL 与版本信息）。
 */
async function deployWorker() {
  log("deploy", "部署 Worker…");
  const result = await runWrangler(["deploy", "--config", RESOLVED_CONFIG_PATH]);
  if (result.code !== 0) {
    console.error(`[deploy] 部署失败（退出码 ${result.code}），已中止。`);
    process.exit(1);
  }
  log("deploy", "部署完成。");
}

/**
 * 主流程：解析模式 → 读取仓库配置 → 解析/创建数据库 → 写 resolved 配置 →
 * 按模式执行迁移/部署。
 */
async function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  if (mode === "help") {
    // 纯本地短路：不检查 wrangler、不读配置、不发起任何 wrangler 调用
    printUsage();
    return;
  }

  if (!existsSync(WRANGLER_BIN)) {
    console.error(
      `[deploy] 未找到本地 wrangler（${WRANGLER_BIN}），请先运行 npm install。`,
    );
    process.exit(1);
  }

  // 读取仓库 wrangler.jsonc（路径基于脚本位置推导，与 cwd 无关）
  const rawText = readFileSync(SOURCE_CONFIG_PATH, "utf8");
  const parsed = parseWranglerConfig(rawText);
  const database = parsed?.d1_databases?.[0];
  if (database === undefined || typeof database.database_name !== "string") {
    console.error(
      "[provision] wrangler.jsonc 缺少 d1_databases[0].database_name，无法解析目标数据库。",
    );
    process.exit(1);
  }
  const databaseName = database.database_name;

  // 信息性提示：无论当前 database_id 是占位符还是真实 id，都以名称为唯一事实源
  if (database.database_id === PLACEHOLDER_DATABASE_ID) {
    log("provision", `配置 database_id 为占位符，将以名称 ${databaseName} 解析真实 id。`);
  } else {
    log(
      "provision",
      `配置 database_id 为 ${database.database_id}，仍以名称 ${databaseName} 为准重新解析。`,
    );
  }

  const { uuid, source } = await resolveDatabaseId(databaseName);
  if (source === "env") {
    log("provision", `使用 D1_DATABASE_ID 指定的数据库 ${uuid}`);
  } else if (source === "existing") {
    log("provision", `数据库 ${databaseName} 已存在，复用 ${uuid}`);
  }
  // source === "created" 已在 createDatabase 内打印「已创建数据库 …」

  // 真实 id 只写入 .wrangler/ 下的临时配置（仓库文件不动）
  mkdirSync(RESOLVED_CONFIG_DIR, { recursive: true });
  writeFileSync(RESOLVED_CONFIG_PATH, buildResolvedConfig(rawText, uuid), "utf8");
  log("provision", `已写入 resolved 配置：${RESOLVED_CONFIG_PATH}`);

  if (mode === "provision-only") {
    log(
      "provision",
      `数据库存在性：${source === "existing" ? "已存在" : source === "created" ? "本次新建" : "由 D1_DATABASE_ID 指定"}`,
    );
    log("provision", `数据库名称：${databaseName}`);
    log("provision", `数据库 uuid：${uuid}`);
    log("provision", `resolved 路径：${RESOLVED_CONFIG_PATH}`);
    return;
  }

  // T08：迁移/部署前注入版本模块（wrangler 打包 src/index.ts 需要它存在；CF
  // Workers Builds 在干净检出上跑 npm run deploy，此时文件尚未生成，这里就是
  // 远端构建的注入时机）。--provision-only 不构建，已在上方提前返回。
  generateVersionModule();

  await applyMigrations(databaseName);
  if (mode === "migrate-only") {
    log("migrate", "--migrate-only 模式：跳过部署。");
    return;
  }
  await deployWorker();
}

/**
 * 仅当本文件被 node 直接作为入口执行时才运行 main（import 无副作用）。
 * 用 path.resolve 比较：npm run 传入的 process.argv[1] 是相对路径
 * （如 scripts/deploy.mjs），不能直接与 import.meta.url 的绝对路径比。
 */
function invokedAsEntry() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return path.resolve(process.argv[1]) === SCRIPT_PATH;
  } catch {
    return false;
  }
}

if (invokedAsEntry()) {
  main().catch((error) => {
    console.error(
      `[deploy] 未预期的错误：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  });
}
