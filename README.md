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

三条路径共用同一套声明式配置（`wrangler.jsonc` + `.dev.vars.example`），按场景选其一。

### 路径一（推荐 · 已有仓库）：面板导入

2026-09-28 已用本仓库实测走通：

1. Cloudflare 面板 → **Workers & Pages → Create → Workers → Import a repository**
2. 授权 Cloudflare GitHub App，把 `huaiminyetnotsleep/hodor` 加入可访问范围并选中
3. 向导逐项配置：
   - 项目名称：`hodor`
   - D1 数据库：**+ 新建**，命名 `hodor`（向导自动创建真实 D1 并把 database_id 写进部署配置，替代 wrangler.jsonc 占位符）
   - 变量表单：向导按 `.dev.vars.example` 的**每个未注释条目**生成一个表单项——7 条逐项填真值，注释即填写说明
   - 构建命令：**留空**（TypeScript 由 wrangler 打包，无构建步骤）
   - 部署命令：`npx wrangler d1 migrations apply hodor --remote && npx wrangler deploy`
     （⚠️ 默认 `npm run deploy` 不执行迁移，必须改；迁移幂等，每次 push 重跑安全）
   - 关闭「启用预览构建」（Phase 1 无 preview 分支部署需求）
4. 点部署 → 验证：`curl https://hodor.<你的子域>.workers.dev/health` → `{"ok":true,"version":"0.1.0"}`（S9 起 `POST /admin/setup` 完成绑定与 setWebhook）
5. 此后 **push main 即自动构建部署**，无需任何手工命令

### 路径二：Deploy 按钮（适合没有现成仓库的全新使用方）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/huaiminyetnotsleep/hodor)

实测注意（2026-09-28）：

- 该流程会**新建一个 GitHub 仓库副本**再连接，与已有同名仓库冲突（报「已存在具有该名称的存储库」）——已有仓库请走路径一
- 报「无法获取存储库内容」多为瞬时失败：确认仓库为 Public、URL 为标准 HTTPS 地址（非 `git@…` SSH 形式），稍后重试或直接走路径一
- 其余置备项（D1 / 7 变量 / 部署命令）与路径一相同；`.dev.vars.example` 一职两用（本地开发模板 + 表单清单）

### 路径三：手工 wrangler deploy（不依赖 GitHub，救急/本地验证用）

```bash
# 一次性：登录 + 建库（database_id 回填 wrangler.jsonc）
npx wrangler login
npx wrangler d1 create hodor

# 每次发布：迁移（幂等）→ 注入远端变量（仅首次或值变更时）→ 部署
npx wrangler d1 migrations apply hodor --remote
for v in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET ADMIN_SETUP_SECRET \
         SUPPORT_CHAT_ID ADMIN_IDS ALLOW_UNKNOWN_USERS MAX_ATTEMPTS; do
  npx wrangler secret put "$v"
done
npx wrangler deploy

# 验证
curl https://hodor.<你的子域>.workers.dev/health   # 期望 {"ok":true,"version":"0.1.0"}
```

### 部署后的更新与回滚（三条路径通用）

- 源码更新走 push 自动部署（路径三则手工 deploy）；**不再点按钮 / 不再重复导入**
- 回滚：Dashboard → Deployments 一键回退（秒级）或 `npx wrangler rollback`；**Worker 回滚不回滚 D1**，迁移始终 append-only（docs/08）
- Webhook URL、Secrets、D1 资源跨更新原样保留（发布不重设 Webhook，docs/08）
- Bot 行为的人工验证从 S4 开始（首条真实消息建 Topic）；S1 阶段远端验证的是部署链路与 `/health`

## 运维（docs/09 约定）

- 只读查询走 Makefile：`make db-customers` / `db-conversations` / `db-messages` / `db-inbox-failed`（加 `REMOTE=1` 打远端）
- 管理端操作不封装脚本，直接调 `/admin/*` 端点（docs/05），Bearer `ADMIN_SETUP_SECRET`（S9 起可用）
