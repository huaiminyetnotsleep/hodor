# 本地开发

本页面向要改代码的贡献者与自部署者：如何在本地跑测试、起 Worker、查看本地 D1 数据。本地开发与线上部署**完全隔离**——所有本地数据落在仓库内的 `.wrangler/state/`（已被 git 忽略），永不触碰远程数据库。

## 一次性准备

根项目工具链要求 **Node 24**（版本锚定在 `.nvmrc`，CI 使用同一版本；下方文档站为独立环境，另行管理，不适用此要求）。

```bash
npm install                    # 根目录安装：wrangler 4 / vitest 4 / vitest-pool-workers
cp .dev.vars.example .dev.vars # .dev.vars 已被 git 忽略，不会进入提交
```

::: tip
测试所需的变量已由 `vitest.config.ts` 显式注入（不依赖本地 `.dev.vars`，不同机器结果一致）。

`.dev.vars` 供 `wrangler dev` 手动运行使用——模板条目默认全部注释，复制后逐条取消注释并填值（必填 5 条必须启用，选填按需；Turnstile 三项仅在本地联调验证模式时启用，见[验证本地联调](#验证本地联调)），真机联调时再填入真实 token。
:::

文档站（本站）的依赖独立装在 `docs/` 下，首次运行会自动安装：

```bash
npm run docs:dev
```

文档站配置了 `base: '/hodor/'`（GitHub Pages 项目页路径），设置 base 后本地预览地址为 `http://localhost:5173/hodor/`。

## 日常开发：以测试为主循环

日常改动以测试为验证手段。测试通过 `@cloudflare/vitest-pool-workers` 在**真实 workerd 沙箱**里运行（不是 mock）：

- `vitest.config.ts` 从 `wrangler.jsonc` 取 `HODOR_DB` 绑定，并在 Node 侧读取 `migrations/` 注入为 `TEST_MIGRATIONS` 绑定
- 每个测试文件在 `beforeAll` 里 `applyD1Migrations`，对**各自隔离的本地 D1** 应用迁移，文件之间互不共享状态

```bash
npm test             # 单次全量运行
npm run test:watch   # 监听模式
npm run typecheck    # tsc --noEmit
```

### 写新测试的两种范式

**数据库断言**——先应用迁移，再用 `env.HODOR_DB` 裸 SQL（范例：[`test/schema.test.ts`](https://github.com/huaiminyetnotsleep/hodor/blob/main/test/schema.test.ts)）：

```ts
import { applyD1Migrations, env } from "cloudflare:test";

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

it("settings 读写", async () => {
  await env.HODOR_DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('verify_enabled', '1')",
  ).run();
});
```

**HTTP 行为**——用 `SELF.fetch` 走完整 fetch 入口（范例：[`test/health.test.ts`](https://github.com/huaiminyetnotsleep/hodor/blob/main/test/health.test.ts)）。

这类测试不碰数据库，无需应用迁移：

```ts
import { SELF } from "cloudflare:test";

it("GET /health", async () => {
  const res = await SELF.fetch("https://example.com/health");
  expect(res.status).toBe(200);
});
```

::: tip
测试里的 `console.log` 可以直接当调试打点，输出会出现在 vitest 日志里。
:::

## 手动运行 Worker

先把迁移应用到本地 D1：

```bash
npm run db:migrate:local
```

::: warning
`wrangler dev` **不会**自动应用迁移。本地库还是空表时先跑上面这条；新增迁移文件后也要重跑。
:::

然后启动：

```bash
npm run dev        # → http://127.0.0.1:8787
```

冒烟验证：

```bash
curl http://127.0.0.1:8787/health
# {"status":"ok","version":"x.y.z"}
```

查看本地库数据（以 `settings` 表为例）：

```bash
npx wrangler d1 execute hodor --local --command "SELECT * FROM settings"
```

::: tip
`wrangler.jsonc` 中的 `database_id` 只是占位符，**不影响本地模式**——本地状态按 `database_name`（`hodor`）键控。

只有 `--remote` 操作（如 `npm run db:migrate:remote`）才需要真实 id，见[部署流程](./deploy.md)。
:::

当前已交付（完整 v1 + Turnstile 人机验证）：

- `POST /webhook`（文本 + 7 类媒体双向中继、人机验证、限频、全套管理命令）
- `GET /health`（存活探针）
- `GET /selfcheck`（完整自检）
- `/setwebhook/<ADMIN_SECRET>` 与 `/deletewebhook/<ADMIN_SECRET>`（绑定 / 解绑 + 命令菜单注册）
- `GET /verify?r=<nonce>`（Turnstile 验证页面，Telegram Mini App 嵌入）
- `POST /api/verify/turnstile`（网页验证完成入口：initData 身份 + Siteverify + D1 条件裁决）

本地 `wrangler dev` 无法接收 Telegram 推送（公网不可达），真机联调需部署后绑定 webhook，见[部署流程](./deploy.md)。

## 人机验证（Turnstile）本地联调 {#验证本地联调}

在 `.dev.vars` 中取消注释并填入 Cloudflare 官方**测试密钥对**（始终通过）：

```bash
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

其他测试组合（始终失败等）见[官方测试文档](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)。

- **凭据隔离**：测试密钥只进本地 `.dev.vars`（git 忽略）；生产实例配置官方测试密钥会被 `/selfcheck` 直接报错。反过来，真实生产密钥不要留在 `.dev.vars`，更不能提交
- **完整身份链路需要 HTTPS + 测试 Bot**：`wrangler dev` 的 `127.0.0.1` 地址打不开 Mini App 按钮，Telegram 签名身份数据（initData）也只在真实 Bot 会话中产生。要端到端走通，需把分支部署到 HTTPS 地址（workers.dev 或自定义域）并用测试 Bot 验收
- **本地浏览器不能替代真机**：普通浏览器打开 `/verify?r=…` 只会看到「请从 Bot 打开」提示（缺 initData，按设计不放行）；Telegram 各端内嵌 WebView 的兼容性以真机实测为准，自动化测试与桌面浏览器通过不代表全部客户端可用

## 命令速查

来源：`package.json` 的 `scripts`。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | `wrangler dev`，本地 127.0.0.1:8787 |
| `npm test` / `npm run test:watch` | vitest 单次 / 监听 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate:local` | 迁移应用到本地 D1 |
| `npm run db:migrate:remote` | 迁移应用到远程 D1（部署流程，本地开发用不到） |
| `npm run cf-typegen` | 重新生成 `worker-configuration.d.ts` |
| `npm run deploy` | 一键部署：版本注入 → 置备 D1 → 远端迁移 → 部署（迁移失败则中止；部署流程用） |
| `npm run provision` | 仅置备（解析/创建 D1、注入 database_id），不部署 |
| `npm run docs:dev` / `npm run docs:build` | 文档站开发 / 构建 |

## 注意事项

以下各条都是实测踩过的坑，保留因果说明：

1. **`compatibility_date` 固定 `2026-08-22`**——这是内置 workerd 的支持上限。写更晚的日期，`wrangler dev` / vitest 会直接启动失败（`This Worker requires compatibility date …`），不要随手改成当天日期。
2. **跑 `npm run cf-typegen` 前先把 `.dev.vars` 移开，生成后移回**——否则生成器会把 `.dev.vars` 里的键一并写进提交的 `worker-configuration.d.ts`，使它们变成必填的 `Cloudflare.Env` 绑定。提交的文件必须只包含 `wrangler.jsonc` 声明的绑定。
3. **`@cloudflare/vitest-pool-workers@0.22.x` 与 `vitest@^4.1.0` 严格配对**——单独把 vitest 升到 5.x 会报 `Missing "./config" specifier`。升级必须一起动。
4. **测试代码运行在 workerd 沙箱，没有 `node:fs`**——读文件必须在 Node 侧完成、经绑定注入（现有接线已是如此：`vitest.config.ts` 用 `readD1Migrations` 读取并注入）。不要在测试里 import `node:fs`，会报 `no such file or directory`。

## 相关页面

- [部署流程](./deploy.md)
- [发布与更新](./release.md)
- [数据表](./database.md)（表结构唯一事实源）
- [运维手册](./ops.md)
