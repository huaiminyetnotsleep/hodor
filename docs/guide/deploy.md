# 部署流程

本页是首次部署的唯一完整指南：前置条件 → 环境变量 → 三条部署路径 → 部署后收尾与验收。更新已有实例见[发布与更新](/guide/release.md)，日常运维与排障见[运维手册](/guide/ops.md)。

## 前置条件

### Telegram 侧

1. **申请 bot**：找 [@BotFather](https://t.me/BotFather) → `/newbot`，按提示完成后记下 bot token（即 `TELEGRAM_BOT_TOKEN`）。可选：`/setprivacy` → Disable（防御性冗余，当前实现不依赖群内普通消息）
2. **创建私有超级群组**：新建群组，**不设公开用户名**，在群设置中开启「话题」（Topics）功能；**不要**开启「保护内容」（protected content）——限制保存内容会影响媒体中继（实测项）
3. **把 bot 拉进群并设为管理员**，至少授予以下四项权限：
   - **管理话题**（创建 / 关闭 / 重开 topic）
   - **发送消息**
   - **删除消息**（`/deluser`、`/purgemsg` 等清理命令需要）
   - **置顶消息**（每个话题置顶用户信息卡需要）

### 获取两个 Telegram ID

| 变量 | 是什么 | 获取方法 |
| --- | --- | --- |
| `SUPPORT_CHAT_ID` | 客服超级群组的 chat_id（`-100` 开头负数） | bot 进群后往群里随便发一条消息，浏览器打开 `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`，记下返回中的 `chat.id`；也可邀请 [@sc_ui_bot](https://t.me/sc_ui_bot)、[@getidsbot](https://t.me/getidsbot) 等工具 bot 进群后发 `/id` |
| `ADMIN_IDS` | 管理员的 Telegram 用户 ID（逗号分隔，可多个） | 同上 getUpdates 返回中你那条消息的 `from.id`；或在 Telegram 内向 [@getidsbot](https://t.me/getidsbot) 等工具 bot 发任意消息直接读出自己的 user ID |

## 环境变量（共 9 个，权威清单）

| 变量 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Secret | ✅ | — | bot token，仅存环境变量，永不进 URL |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | ✅ | — | 绑定 webhook 时传给 Telegram 的官方 `secret_token`（≥16 位，字母数字下划线连字符）；此后每条 update 都带专用请求头用于防伪造 |
| `ADMIN_SECRET` | Secret | ✅ | — | `setwebhook` / `deletewebhook` 管理端点的访问凭证（URL 路径段） |
| `SUPPORT_CHAT_ID` | Var | ✅ | — | 超级群组 ID（`-100` 开头） |
| `ADMIN_IDS` | Var | ✅ | — | 管理员 Telegram 用户 ID，逗号分隔，支持多个 |
| `MAX_MESSAGES_PER_MINUTE` | Var | — | `20` | 每用户每分钟转发上限，超限触发重新验证 |
| `VERIFY_TTL_HOURS` | Var | — | `0` | 验证有效期（小时），`0` = 永久 |
| `MAX_ATTEMPTS` | Var | — | `3` | 同一条 update 处理失败的最大重试次数，超限标记失败跳过 |
| `WELCOME_TEXT` | Var | — | 内置默认文案 | 自定义欢迎语，支持换行；字面 `\n` 会解释为换行 |

::: warning
三个 Secret（`TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `ADMIN_SECRET`）请使用**互不相同**的长随机串。
:::

**配置入口**统一为 Cloudflare 面板 → Worker → 设置 → **变量和机密**：3 个 Secret 用「机密（Secret）」类型，`SUPPORT_CHAT_ID` / `ADMIN_IDS` 与 4 条选填用「文本（Text）」类型。

仓库已开启 `keep_vars`，面板配置的变量跨部署保留（Secret 本就不因部署删除）；变量值一律不进仓库。

本地调试可选 `cp .dev.vars.example .dev.vars` 后填值（git 忽略，与面板互不影响）。

## 部署方式（三选一）

三条路径共用同一套仓库声明式配置（`wrangler.jsonc` + `.dev.vars.example`）。

D1 数据库的创建、`HODOR_DB` 绑定与表迁移全部自动化，**无需在 dashboard 手动建库**；真实 database_id 不进仓库（仓库内恒为占位符，部署管线按名字解析并注入构建工作区，不改你的仓库）。

### 路径一（推荐）：fork 后部署（Workers Builds，全程浏览器）

1. **Fork 本仓库** `huaiminyetnotsleep/hodor` 到自己的 GitHub 账号
2. **连接 Git**：Cloudflare 面板 → Workers & Pages → Create → Workers → **Import a repository** → 授权 Cloudflare GitHub App → 选中你的 fork，向导逐项：
   - 项目名称：`hodor`（即 Worker 地址 `hodor.<你的子域>.workers.dev`）
   - 变量表单**不会出现**（`.dev.vars.example` 条目全部注释 = 零提示）：所有变量统一部署后面板配置，见下方「部署后收尾」
   - 构建命令**留空**；部署命令**保持向导默认 `npx wrangler deploy`**——D1 置备与迁移由 `npm install` 的 postinstall 钩子（按 `WORKERS_CI=1` 门控）在安装阶段自动完成，先于部署执行
   - 关闭「启用预览构建」（无 preview 分支部署需求）
3. 保存后自动触发首次部署；此后每次 push 到 `main` 即自动发布新版本

> 仓库所有者本人部署：无需 fork，Import a repository 直接选现有仓库，其余相同。

### 路径二：GitHub URL 一键部署（Deploy 按钮）

适合没有任何现成仓库的全新使用方——浏览器打开：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/huaiminyetnotsleep/hodor)

Cloudflare 会在你的 GitHub 账号下**自动创建仓库副本**（相当于自动 fork）并完成置备连接；其余部署项与路径一相同（零变量表单、部署后面板配置）。

注意：

- 副本仓库名默认取项目名，你的账号下已有同名仓库会报「已存在具有该名称的存储库」——此时改走路径一
- 报「无法获取存储库内容」多为瞬时失败：确认 URL 为标准 HTTPS 地址（非 `git@…` SSH 形式）、仓库 Public，稍后重试或改走路径一

### 路径三：手工 wrangler（不依赖 GitHub，救急 / 本地验证）

需要本地 Node 24：

```bash
npx wrangler login
npm run deploy   # = node scripts/deploy.mjs：自动建/复用 D1 → 远端迁移 → 部署；迁移失败即中止、不部署
curl https://hodor.<你的子域>.workers.dev/health
```

后续更新与回滚见[发布与更新](/guide/release.md)。

### 部署排错

| 现象 | 原因与处理 |
| --- | --- |
| 构建日志报 `The database … could not be found (7404 / 10181)` | 自动置备未生效：查构建日志**安装阶段**的 `[provision]` 输出；兜底把部署命令改为 `npm run deploy`（显式置备后部署）再重新部署 |
| 构建令牌无 D1 建库权限 | 在面板手动建好同名 D1 再重跑（脚本按名字复用，仍零仓库改动）；或在面板创建具备 D1 编辑权限的自定义 token 配到 `CLOUDFLARE_API_TOKEN` |
| 部署后变量丢失 | 确认部署所用代码包含 `keep_vars: true`（本仓库已配置）；仍丢失时检查变量是否配在了别的 Worker 上 |

## 部署后收尾

按以下顺序执行，用 `/selfcheck` 逐步把检查清零：

1. **存活确认**：浏览器打开 `https://<worker-url>/health`，应返回 `{"status":"ok","version":"…"}`（存活探针 + 版本号）
2. **完整自检**：打开 `https://<worker-url>/selfcheck`。变量未配齐时返回 503 与 `failed` 数组，逐条列出缺失 / 非法的变量（不回显密钥值）——据此回到 设置 → 变量和机密 补齐 5 条必填变量（4 条选填按需配置，均有内置默认值）
3. **绑定 webhook**：打开 `https://<worker-url>/setwebhook/<你的 ADMIN_SECRET>`，回显 bot 身份即成功（同时自动注册管理命令菜单；详见[运维手册](/guide/ops.md)）
4. **复查自检**：再次打开 `/selfcheck`，应全绿返回 `{"status":"ok","version":"…"}`
5. **聊天验收**：用 Telegram 账号直接给 bot 发消息（无需 `/start`）→ 收到欢迎语 + 数学题验证码 → 点对答案 → 群组出现该用户的话题（置顶用户信息卡显示 ✅ 已验证）且消息中继；管理员在话题里直接回复，用户私聊收到

全部功能（7 类媒体、验证开关与模式、全部管理命令、会话清理、`/selfcheck`）已随完整 v1 发布；行为细节见[功能介绍](/guide/features.md)。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 部署后 bot 无响应 | webhook 未绑定；或 `TELEGRAM_WEBHOOK_SECRET` 与绑定时不一致（update 校验 401），重新执行 setwebhook。更多排查见[运维手册 · 故障排查](/guide/ops.md#故障排查) |
| 消息进了群但没建 topic | bot 缺少「管理话题」权限 |
| `/purgemsg` 执行失败 | bot 缺少「删除消息」权限 |
| 突然全部请求 429 | Cloudflare 套餐请求配额用尽（免费套餐为每日 10 万请求），见[运维手册 · 故障排查](/guide/ops.md#故障排查) |
