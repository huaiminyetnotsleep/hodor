# hodor

Telegram Forum Topics 客服消息中继 Bot —— 一个用户，一个话题，消息不串线。
完整设计文档见 [docs/README.md](docs/README.md)（v2.12，12 篇）。

## 准备工作（一次性，docs/05 前置清单）

**Telegram 侧**

1. @BotFather `/newbot` 建 Bot，保存 Token（`TELEGRAM_BOT_TOKEN`）；`/setprivacy` → Disable（防御性冗余）
2. 建一个**私有** Supergroup（不设公开用户名），在群设置里开启 **Topics**；**不开** protected content（docs/02 红线）
3. 把 Bot 拉进群并授予：Manage Topics / Send Messages / Delete Messages / Pin Messages
4. 绑定 Webhook 之前先取 ID：往群里随便发一条消息，浏览器打开
   `https://api.telegram.org/bot<TOKEN>/getUpdates`，从返回里记下群 `chat_id`（`-100` 开头负数）和你自己的 `user_id`

**Cloudflare 侧**

5. 登录：`npx wrangler login`
6. 建库：`npx wrangler d1 create hodor`，把输出的 `database_id` 填回 `wrangler.jsonc`

**环境变量**

7. `cp .dev.vars.example .dev.vars`（本地开发用）；部署后在面板 Worker → 设置 → 变量和机密 配置同样 7 条（一次即可，`keep_vars: true` 已保证跨部署持久）

## 环境变量说明（模板与注释见 `.dev.vars.example`）

| 变量 | 说明 | 敏感 | 缺省 |
|------|------|------|------|
| `TELEGRAM_BOT_TOKEN` | Bot Token（BotFather 发放） | 是 | — |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram 回调头鉴权（SHA-256 比对）；三个 Secret 必须互异 | 是 | — |
| `ADMIN_SETUP_SECRET` | `/admin/*` 管理端 Bearer | 是 | — |
| `SUPPORT_CHAT_ID` | 私有支持群 chat_id（`-100` 开头） | 否 | — |
| `ADMIN_IDS` | 管理员 user_id 白名单，逗号分隔 | 否 | — |
| `ALLOW_UNKNOWN_USERS` | 未知用户首条消息是否建户建档（docs/09） | 否 | `true`（仅显式 `"false"` 关闭） |
| `MAX_ATTEMPTS` | inbox 处理尝试上限（docs/03 重试闭环） | 否 | `8` |

注入方式（⚠️ 2026-09-28 实测与官方文档核实）：`wrangler deploy` 默认按配置重置绑定，但本仓库已设 **`keep_vars: true`**——面板「变量和机密」配置的变量（Text 或机密均可）**跨部署持久**；官方文档另明确 **Secrets 永不因部署删除**。

- **全部 7 个**：部署后在面板 Worker → 设置 → 变量和机密 配置一次即可（fork 使用者零代码改动）；3 个 Secret 建议用「机密」类型，4 个配置 Text/机密均可
- **本地开发**：写 `.dev.vars`（已被 git 忽略），与面板互不影响
- 也可用 `npx wrangler secret put <NAME>`（Secret 类型，等价持久）

## 开发流程

```bash
npm install
cp .dev.vars.example .dev.vars                    # 本地开发用；远端在面板「变量和机密」配一次
npx wrangler d1 migrations apply hodor --local    # 本地建表（幂等，可重复执行）
npm run dev                                       # http://localhost:8787/health
npm test                                          # Vitest：本地 D1 + 打桩 Telegram
npm run typecheck && npm run lint
make db-customers                                 # 只读巡检（另有 db-conversations / db-messages / db-inbox-failed）
```

当前实现进度（S1）：Worker 仅暴露 `GET /health`；webhook 路由 S3、管理命令 S6–S8、`/admin` 端点 S9 按任务树逐步挂载。任务树与各子任务验收标准见 `.trellis/tasks/`。

## 部署到 Cloudflare（自动部署 · Workers Builds）

三条路径共用同一套声明式配置（`wrangler.jsonc` + `.dev.vars.example`）。本项目面向自部署：**第三方使用者推荐「fork 后部署」**，每份部署独享自己的 D1 与变量。

### 路径一（推荐）：fork 后部署（零仓库改动，全程浏览器）

第三方使用者：

1. Fork `huaiminyetnotsleep/hodor` 到自己的 GitHub 账号
2. Cloudflare 面板 → **Workers & Pages → Create → Workers → Import a repository** → 授权 Cloudflare GitHub App → 选中**你的 fork**，向导逐项配置：
   - 项目名称：`hodor`
   - 变量表单：7 个值在此一次填齐（向导按 `.dev.vars.example` 生成表单项）；`keep_vars: true` 已在仓库配置，这些值**跨部署持久，fork 使用者零代码改动**（3 个 Secret 建议机密类型）
   - 构建命令：**留空**；部署命令：**保持向导默认 `npx wrangler deploy`，无需改动**——置备（创建/复用同名 D1 → 注入 database_id 到构建工作区，**不改动你的仓库** → 幂等迁移）由 `npm install` 的 postinstall 钩子自动完成，先于部署执行
   - 关闭「启用预览构建」（Phase 1 无 preview 分支部署需求）
3. 部署 → 验证：`curl https://hodor.<你的子域>.workers.dev/health` → `{"ok":true,"version":"0.1.0"}`（S9 起 `POST /admin/setup` 完成绑定与 setWebhook）
4. 此后 **push 你的 fork 即自动构建部署**；上游更新 → fork 页点 **Sync fork** → 自动部署（docs/05）

> 排错：报 `The database … could not be found (7404 / 10181)` = 自动置备未生效——先查构建日志**安装阶段**的 `[provision]` 输出；兜底：把部署命令改为 `npm run deploy`（显式置备后部署）再重建。
> 部署后变量丢失：确认部署所用代码包含 `keep_vars: true`（本仓库已配置，wrangler.jsonc）；仍丢失时检查变量是否加在了别的 Worker 上。
> 若构建令牌无建库权限：在面板建好同名 D1 再重跑，脚本会按名字复用，仍零仓库改动。
>
> 仓库所有者本人部署：无需 fork，Import a repository 直接选现有仓库，其余相同。

### 路径二：GitHub URL 一键部署（Deploy 按钮）

适合没有任何现成仓库的全新使用方——点按钮，Cloudflare 会在你的 GitHub 账号下**自动创建仓库副本**（相当于自动 fork）并完成置备连接：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/huaiminyetnotsleep/hodor)

实测注意（2026-09-28）：

- 副本仓库名默认取项目名——你的账号下已有同名仓库会报「已存在具有该名称的存储库」（仓库所有者部署请走路径一直接导入现有仓库）
- 报「无法获取存储库内容」多为瞬时失败：确认 URL 为标准 HTTPS 地址（非 `git@…` SSH 形式）、仓库 Public，稍后重试或改走路径一
- 其余置备项（D1 / 7 变量 / 部署命令）与路径一相同；`.dev.vars.example` 一职两用（本地开发模板 + 表单清单）

### 路径三：手工 wrangler（不依赖 GitHub，救急/本地验证用）

```bash
npx wrangler login
npm run deploy          # = node scripts/deploy.mjs：自动建/复用 D1、注入 id、迁移、部署
curl https://hodor.<你的子域>.workers.dev/health
```

仅注入/更新变量时：`npx wrangler secret put <NAME>`（共 7 个，见 `.dev.vars.example`）。

### 与业界做法的对照

「零配置部署 + 数据库置备」在业界有三种成熟模式，本项目各取所长：

| 模式 | 业界代表 | hodor 的对应 |
|---|---|---|
| **配置即资源**（IaC in repo）：平台按声明置备并回写 | Render `render.yaml`、CF 模板向导/按钮 | wrangler.jsonc 即声明式资源描述；路径二（按钮）由平台置备 D1 |
| **置备/迁移是部署管线的独立阶段** | Heroku release phase、Render `preDeployCommand`、Fly `release_command` | `scripts/provision.mjs`：postinstall 自动执行（或 `npm run provision` 显式执行），先于 `wrangler deploy` |
| **平台侧建库 + env 注入引用**（连接信息不进仓库） | Vercel Marketplace、Heroku Add-ons（`DATABASE_URL` 模式） | 7 个变量全部走表单/Secret；D1 是同平台 binding（需静态 database_id），不适用 env 引用，故用前两种模式 |

业界同样没有的第四种——让用户手改配置文件里的资源 ID——正是本方案要消除的。

### 部署成功的验证（三条路径通用）

1. **Worker 存活**：`curl https://hodor.<你的子域>.workers.dev/health` → 期望 `{"ok":true,"version":"0.1.0"}`
   - workers.dev 地址：面板 → Workers & Pages → `hodor` → 右上角「访问」，或 Settings → Domains & Routes；首次部署后 DNS 需等几十秒
2. **数据库连通**（二选一）：
   - 本机已 `npx wrangler login`：`make db-customers REMOTE=1` → 返回 `success: true` 即迁移已在远端生效
   - 面板：Storage & Databases → `hodor` → Tables 里能看到 8 张表
3. **自动部署闭环**：任意 push 一个提交 → Workers Builds 自动构建部署，全程无手工命令

阶段验证边界：S1 只验证 /health + 数据库连通；S3 起 webhook 生效（错误 Secret 返回 401）；**S4 起真机回归（首条消息落 Topic 等 5 步清单）见 [scripts/dev/bootstrap.md](scripts/dev/bootstrap.md)**。

### 部署后的更新与回滚（三条路径通用）

- 源码更新走 push 自动部署（路径三则手工 deploy）；**不再点按钮 / 不再重复导入**
- 回滚：Dashboard → Deployments 一键回退（秒级）或 `npx wrangler rollback`；**Worker 回滚不回滚 D1**，迁移始终 append-only（docs/08）
- Webhook URL、Secrets、D1 资源跨更新原样保留（发布不重设 Webhook，docs/08）
- Bot 行为的人工验证从 S4 开始（首条真实消息建 Topic）；S1 阶段远端验证的是部署链路与 `/health`

## 运维（docs/09 约定）

- 只读查询走 Makefile：`make db-customers` / `db-conversations` / `db-messages` / `db-inbox-failed`（加 `REMOTE=1` 打远端）
- 管理端操作不封装脚本，直接调 `/admin/*` 端点（docs/05），Bearer `ADMIN_SETUP_SECRET`（S9 起可用）
