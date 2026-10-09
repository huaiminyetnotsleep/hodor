# 部署管线（Deployment Pipeline）

> `scripts/deploy.mjs` + `scripts/lib/config.mjs` + `wrangler.jsonc` 构成的置备/迁移/部署管线的可执行契约。改动其中任一文件前必读。

---

## 场景：D1 置备与多实例名称派生

### 1. Scope / Trigger

- 触发：任何触及 D1 数据库命名、置备顺序、配置注入或 Workers Builds 钩子的改动（2026-10-09 多实例部署任务确立）。
- 核心不变量：**D1 数据库名 = Worker 名**；实例名是用户唯一需要提供的东西（起个 Worker 名即得到完全隔离的实例）。

### 2. Signatures

```js
// scripts/lib/config.mjs（纯模块：禁 process / node:*，workerd 沙箱可测）
deriveInstanceNames(env, configWorkerName)
  // -> { workerName, databaseName }，两者恒相等（1:1，不引入第二个派生源）
withDatabaseName(text, name)   // 原地替换 d1_databases[0].database_name，注释逐字保留
withDatabaseId(text, uuid)     // 原地替换 d1_databases[0].database_id（既有）

// scripts/deploy.mjs（编排层，不被测试导入）
buildResolvedConfig(rawText, uuid, databaseName) // resolved 配置：id + 派生名 + main/migrations_dir 绝对路径
resolveDatabaseId(databaseName) // D1_DATABASE_ID → d1 list 按名查找 → d1 create
```

### 3. Contracts

| 输入 | 性质 | 契约 |
| --- | --- | --- |
| `WRANGLER_CI_OVERRIDE_NAME` | 构建期（Workers Builds 注入） | 连接 Worker 名，trim 后非空才采用；**install 阶段可见性未文档化**，缺失是合法情形不是错误 |
| `D1_DATABASE_ID` | 构建期逃生口 | 优先级最高，绕过派生直接指定 uuid |
| `WORKERS_CI` | 构建期门控 | 仅 `=== "1"` 放行 install-hook；先于一切副作用判定 |
| 仓库 `wrangler.jsonc` | 恒定 | 顶层 `name: "hodor"` 与 `database_name: "hodor"` 是回退基线，字段值永不进 git 改动（注释除外）；真实 id 只进 `.wrangler/resolved.wrangler.jsonc`（本地）或构建工作区（install-hook 就地注入，不回传 git） |

派生回退链：`WRANGLER_CI_OVERRIDE_NAME`（trim 非空）→ 配置 `name`。**回退即历史行为**（hodor → hodor），这是所有兼容性保证的根基。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 配置缺顶层 `name` 或 `database_name` | 中文报错中止（仓库配置损坏） |
| `WORKERS_CI=1` 且 override 缺失/空白 | **告警后照常置备（fail-open）**：无法区分「主实例恰叫 hodor」与「多实例但变量不可见」，中止会误伤首实例默认流程；告警须含两要素——共享库风险 + 出路（部署命令改 `npm run deploy`） |
| `d1 create` 因名字不合法失败 | 报错中止，不截断名字（截断有碰撞风险）；出路 `D1_DATABASE_ID` |
| 认证/权限失败（`isAuthFailure`） | 权限引导；7404 **不是**认证失败（2026-09-30 事故教训） |
| 并发同名建库 | `already exist` → 重新 list 复用，不重复建库 |
| 迁移失败 | 中止且不部署（T06 契约，任何模式不变） |

### 5. Good/Base/Bad Cases

- **Good**：Worker 名 `hodor-shop` + override 可见 → 日志 `[provision] 已创建数据库 hodor-shop`，独立库。
- **Base**：本地 `npm run deploy`（无任何构建变量）→ 回退 `hodor`，与历史版本逐字节一致。
- **Bad**：override 不可见 + 用户是多实例 → 告警打印 + 绑定共享库 → 用户按决策树改部署命令重部（文档口径见 docs/guide/deploy.md「部署多个实例」）。

### 6. Tests Required

`test/deploy-config.test.ts`（workerd 沙箱，只 import config.mjs）：

- **AC1 回归断言点**：`deriveInstanceNames({}, "hodor")` 必须得到 `{ workerName: "hodor", databaseName: "hodor" }`——改坏此断言 = 破坏全部存量用户
- trim 采纳 / 空串与纯空白回退 / 1:1 恒等
- `withDatabaseName`：注释逐字保留、与 `withDatabaseId` 叠加、缺键抛错

`deploy.mjs` 不进测试（进程编排）；其行为由 `--help` 人工过目 + 真实构建日志验收。

### 7. Wrong vs Correct

#### Wrong

```js
// 写死仓库名——多实例会串库
const { databaseName } = { databaseName: "hodor" };
const { uuid } = await resolveDatabaseId(databaseName);
```

```js
// override 缺失时中止——误伤名为 hodor 的首实例默认流程
if (!process.env.WRANGLER_CI_OVERRIDE_NAME) process.exit(1);
```

#### Correct

```js
const { databaseName } = deriveInstanceNames(process.env, configWorkerName);
const { uuid } = await resolveDatabaseId(databaseName); // 派生名贯穿查找/迁移/注入
```

```js
// fail-open + 可操作告警（共享库风险 + 改部署命令出路），照常置备
if ((process.env.WRANGLER_CI_OVERRIDE_NAME ?? "").trim() === "") {
  log("install-hook", "告警：…请把部署命令改为 npm run deploy 后重新部署…");
}
```

---

**语言**：中文。相关：[测试基座](./testing.md)（config.mjs 纯度与沙箱边界）、[环境与配置](./env-config.md)（构建期 env 与运行时 Cloudflare.Env 的边界）。
