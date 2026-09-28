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

7. `cp .dev.vars.example .dev.vars`，按逐条注释填全部 7 个值

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

注入方式：本地写 `.dev.vars`（已被 git 忽略）；远端一律 `npx wrangler secret put <NAME>`；值不进任何被提交的文件。

## 开发流程

```bash
npm install
cp .dev.vars.example .dev.vars                    # 填 7 个值
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
   - 变量表单：向导按 `.dev.vars.example` 的**每个未注释条目**生成一个表单项——7 条逐项填真值，注释即填写说明
   - 构建命令：**留空**（TypeScript 由 wrangler 打包，无构建步骤）
   - 部署命令：**保持默认 `npm run deploy`**——部署脚本会自动：创建/复用同名 D1 → 把真实 database_id 注入构建工作区（**不改动你的仓库**）→ 执行幂等迁移 → 部署
   - 关闭「启用预览构建」（Phase 1 无 preview 分支部署需求）
3. 部署 → 验证：`curl https://hodor.<你的子域>.workers.dev/health` → `{"ok":true,"version":"0.1.0"}`（S9 起 `POST /admin/setup` 完成绑定与 setWebhook）
4. 此后 **push 你的 fork 即自动构建部署**；上游更新 → fork 页点 **Sync fork** → 自动部署（docs/05）

> 排错：报 `The database … could not be found (7404)` = 部署命令不是默认的 `npm run deploy`（旧配置直连了占位 database_id）——到 Worker 的 Settings → Build → Deploy command 改回 `npm run deploy` 再重建。
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

### 部署后的更新与回滚（三条路径通用）

- 源码更新走 push 自动部署（路径三则手工 deploy）；**不再点按钮 / 不再重复导入**
- 回滚：Dashboard → Deployments 一键回退（秒级）或 `npx wrangler rollback`；**Worker 回滚不回滚 D1**，迁移始终 append-only（docs/08）
- Webhook URL、Secrets、D1 资源跨更新原样保留（发布不重设 Webhook，docs/08）
- Bot 行为的人工验证从 S4 开始（首条真实消息建 Topic）；S1 阶段远端验证的是部署链路与 `/health`

## 运维（docs/09 约定）

- 只读查询走 Makefile：`make db-customers` / `db-conversations` / `db-messages` / `db-inbox-failed`（加 `REMOTE=1` 打远端）
- 管理端操作不封装脚本，直接调 `/admin/*` 端点（docs/05），Bearer `ADMIN_SETUP_SECRET`（S9 起可用）
