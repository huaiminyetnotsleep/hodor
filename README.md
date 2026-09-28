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

## 验证指南（按子任务编号）

> 每个 S\* 任务的交付验证。自动化验证（`npm test` / typecheck / lint）随构建跑；带 ★ 的人工回归**按序执行、待人工完成**，结果记入对应任务工件。操作细节（seed SQL、setWebhook、排错表）见 [scripts/dev/bootstrap.md](scripts/dev/bootstrap.md)。

### V1 · S1 部署冒烟（✅ 2026-09-28 已通过）

1. `curl https://hodor.<你的子域>.workers.dev/health` → `{"ok":true,"version":"0.1.0"}`（workers.dev 地址：面板 → Workers & Pages → `hodor`）
2. 数据库连通（二选一）：`make db-customers REMOTE=1` 返回 `success:true`；或面板 D1 `hodor` 看到 8 张表
3. 自动部署闭环：任意 push → Workers Builds 自动构建部署

### V2 · S2 Telegram 客户端（✅ 自动化已覆盖）

1. `npm test` 全绿——`telegram-client` 21 例：错误分类矩阵、429 原地重试两路径、参数拼装、缓存命中/过期

### V3 · S3 Webhook 与幂等（✅ 自动化已覆盖）

1. `npm test` 全绿——`webhook-auth` 7 例（缺失/错误 Secret → 401 且零副作用、key 不匹配 → 404）、`inbox-machine` 15 例（docs/10 幂等七条）、`classify` 14 例（忽略矩阵）
2. 手工抽查（可选）：错误 Secret curl → 401；重放同 `update_id` → 200 跳过

### V4 · S4 入站中继 0→1（★ 人工回归，**待执行**）

前提与详细命令：[scripts/dev/bootstrap.md](scripts/dev/bootstrap.md)「快径」（D1 Console seed → setWebhook → /health）。

1. ★ 前置：面板 7 变量已配 + seed bots 行 + setWebhook 成功（getWebhookInfo 无 last_error）
2. ★ 用户 A 首条文本 → 自动建 Topic（标题 `👤 昵称 完整ID · #序号`）+ 消息入 Topic + A 收到 WELCOME
3. ★ A 发图片 → 同 Topic 收到 + `db-messages` 可见 media_file_id
4. ★ 用户 B 发消息 → B 自己的 Topic，与 A 不串线
5. ★ A 改昵称再发 → 标题刷新
6. ★ 重放已登记 `update_id` → 200，不重复建题/发 WELCOME

### V5 · S5 出站中继与 403（★ 人工回归，**待执行**，依赖 V4 完成）

1. ★ 管理员在 Topic A 回复文本 → 用户 A 收到；Topic B 回复 → 用户 B 收到（互不串线）
2. ★ 管理员回复图片/文件 → 用户收到对应媒体
3. ★ A 拉黑 Bot → 管理员回复 → Topic 出现一次「⚠️ 用户已停止与 Bot 的对话」提示；重复回复不刷屏且仍尝试送达
4. ★ A 解除拉黑再发消息 → 管理员回复恢复送达（A 侧也会看到恢复）
5. ★ 非白名单成员在群 Topic 发言 → 无任何中继
6. 自动化：`outbound-handler` 10 例（校验矩阵/403 置位/恢复闭环/429 重投）已覆盖上述逻辑

### V6 · S6 管理命令 /ban /unban（★ 人工回归，**待执行**，依赖 V4/V5 完成）

1. ★ 管理员在 Topic A 发 `/ban` → 命令消息被删（用户不可见）+ A 后续消息被静默阻止 + 标题变 🔇
2. ★ 用户 B 全程不受影响
3. ★ `/unban` → A 恢复、🔇 消失（watchlisted 用户则变 ⚠️）
4. ★ 非白名单账号发 `/ban` → 不执行、无任何反应
5. 自动化：`admin-commands` 14 例（白名单内外/删消息/图标三态/审计/单一事实源联动）

### V7 · S7 高危名单 /risk /unrisk（★ 人工回归，**待执行**，依赖 V6 完成）

1. ★ `/risk` → 标题变 ⚠️ + A 收到置位提示；A 与管理员继续正常收发
2. ★ A 再入站 → 收到 WATCH_NOTICE；24h 内重复入站不再提示
3. ★ 期间 `/ban` → 🔇；`/unban` → 恢复 ⚠️（非 👤，高危标记独立于封禁）
4. ★ `/unrisk` → ⚠️ 消失、WATCH_NOTICE 不再出现
5. 自动化：`admin-risk` 9 例（正交锁定/限频边界/audit）

### V8 · S8 危险命令 /purge /deluser（★ 人工回归，**待执行**，依赖 V6 完成；不可逆操作，建议最后做）

/purge（场景 19）：
1. ★ Topic A 发 `/purge` → 收到确认提示（含 #序号）；`/purge confirm <错误序号>` → 拒绝
2. ★ `/purge confirm <正确序号>` → Topic 整体删除 + D1 无会话残留（db-conversations/db-messages）+ General 公告 + 审计含 purge
3. ★ 该用户再发消息 → 新建 Topic 且 #序号不变

/deluser（场景 21）：
4. ★ 两步确认后 → customer/conversations/messages 全删 + Topic 删除 + General 公告 + 审计含 deluser
5. ★ 该用户再发消息无响应；发 `/start` → 新序号恢复对话，高危标记按墓碑继承
6. 自动化：`admin-danger` 10 例（审计先行顺序断言/墓碑先行/幂等/白名单）

### V5+ · S5 起随任务交付追加本节

出站中继（管理员回复送达/403 提示/恢复提示）、管理命令、管理端点、S10 终验（docs/10 全部 21 条）。

### 部署后的更新与回滚（三条路径通用）

- 源码更新走 push 自动部署（路径三则手工 deploy）；**不再点按钮 / 不再重复导入**
- 回滚：Dashboard → Deployments 一键回退（秒级）或 `npx wrangler rollback`；**Worker 回滚不回滚 D1**，迁移始终 append-only（docs/08）
- Webhook URL、Secrets、D1 资源跨更新原样保留（发布不重设 Webhook，docs/08）
- Bot 行为的人工验证从 S4 开始（首条真实消息建 Topic）；S1 阶段远端验证的是部署链路与 `/health`

## 运维（docs/09 约定）

- 只读查询走 Makefile：`make db-customers` / `db-conversations` / `db-messages` / `db-inbox-failed`（加 `REMOTE=1` 打远端）
- 管理端操作不封装脚本，直接调 `/admin/*` 端点（docs/05），Bearer `ADMIN_SETUP_SECRET`（S9 起可用）
