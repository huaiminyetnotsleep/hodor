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

7. 部署后在面板 Worker → 设置 → 变量和机密 配置 7 条（模板与说明见 `.dev.vars.example`，一次即可，`keep_vars: true` 已保证跨部署持久）；本地调试可选：`cp .dev.vars.example .dev.vars` 后 `npx wrangler dev`

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
- **本地调试（可选）**：`cp .dev.vars.example .dev.vars` 后 `npx wrangler dev`（`.dev.vars` 已被 git 忽略），与面板互不影响
- 也可用 `npx wrangler secret put <NAME>`（Secret 类型，等价持久）

## 开发流程

```bash
npm install
npm test                                          # Vitest：本地 D1 + 打桩 Telegram
npm run typecheck && npm run lint
```

当前实现进度：S1–S10 全部完成（Phase 1 MVP 功能全集：webhook/inbox、双向中继、六条管理命令、/admin 端点、审计、148 例自动化测试全绿）。剩余工作 = 下方 V4–V10 人工回归（分期计划见 V10 小节）。任务树与各子任务验收标准见 `.trellis/tasks/`。

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

> 每个 S\* 任务的交付验证。自动化验证（`npm test` / typecheck / lint）随构建跑；带 ★ 的人工回归**按序执行、待人工完成**，结果记入对应任务工件。

### V1 · S1 部署冒烟（✅ 2026-09-28 已通过）

1. `curl https://hodor.<你的子域>.workers.dev/health` → `{"ok":true,"version":"0.1.0"}`（workers.dev 地址：面板 → Workers & Pages → `hodor`）
2. 数据库连通：面板 D1 `hodor` 看到 8 张表；或在 D1 Console 执行 [scripts/d1-console.sql](scripts/d1-console.sql) 首段表清单查询
3. 自动部署闭环：任意 push → Workers Builds 自动构建部署

### V2 · S2 Telegram 客户端（✅ 自动化已覆盖）

1. `npm test` 全绿——`telegram-client` 23 例：错误分类矩阵、429 原地重试两路径、参数拼装、缓存命中/过期

### V3 · S3 Webhook 与幂等（✅ 自动化已覆盖）

1. `npm test` 全绿——`webhook-auth` 7 例（缺失/错误 Secret → 401 且零副作用、key 不匹配 → 404）、`inbox-machine` 15 例（docs/10 幂等七条）、`classify` 18 例（忽略矩阵 + 出站改判）
2. 手工抽查（可选）：错误 Secret curl → 401；重放同 `update_id` → 200 跳过

### V4 · S4 入站中继 0→1（★ 人工回归，**待执行**）

**准备（一次性，全程浏览器 + 一条 curl，无本地哈希/无 SQL）**

1. 备齐：测试 Bot（Token 已在面板 `TELEGRAM_BOT_TOKEN`）、测试私有 Forum 群（开 Topics、Bot 设管理员）、用户 A/B 账号
2. Bot 进群后在群里发一条消息 → 浏览器打开 `https://api.telegram.org/bot<TOKEN>/getUpdates` → 记下群 `chat.id`（-100 开头）和你的 `from.id`
3. 面板 → Worker → 设置 → 变量和机密：把 `SUPPORT_CHAT_ID`、`ADMIN_IDS` 更新为第 2 步真值（保存即生效）
4. 一键绑定（终端一条命令，两处占位替换；哈希计算/建行/拉白名单/setWebhook 全部由 `/admin/setup` 自动完成）：

   ```bash
   curl -X POST "https://hodor.<子域>.workers.dev/admin/setup" \
        -H "Authorization: Bearer <面板 ADMIN_SETUP_SECRET 的值>"
   ```

   响应含 bot_id / webhook_key / webhook 信息即成功（空请求体 = 自动使用面板变量）
5. 验活：响应里 webhook 项无 `last_error`；或访问 `https://hodor.<子域>.workers.dev/health` → `{"ok":true,"version":"0.1.0"}`

**验证（5 项）**

1. ★ 用户 A 私聊发文本 → 群自动建 Topic（`👤 昵称 完整ID · #序号`）+ 消息入 Topic + A 收到 WELCOME
2. ★ A 发图片 → Topic 收到；D1 Console 查 `messages` 表有 `media_file_id`
3. ★ 用户 B 发消息 → B 自己的 Topic，与 A 不串线
4. ★ A 改昵称再发 → 标题刷新
5. ★ 重放：取 A 刚发那条的 `update_id`，curl 重发同 payload（带 Secret 头）→ 200 且不重复建题/发 WELCOME

排错：401=Bearer 与面板 `ADMIN_SETUP_SECRET` 不一致｜setup 502=Token 错（看响应 message）｜404=路径不符（以 setup 响应返回的 webhook_key 为准）｜无 Topic 创建=查面板 `ALLOW_UNKNOWN_USERS` 或 deleted_users 墓碑｜WELCOME 偶发丢失=best-effort 副调用属正常。

### V5 · S5 出站中继与 403（★ 人工回归，**待执行**，依赖 V4 完成）

1. ★ 管理员在 Topic A 回复文本 → 用户 A 收到；Topic B 回复 → 用户 B 收到（互不串线）
2. ★ 管理员回复图片/文件 → 用户收到对应媒体
3. ★ A 拉黑 Bot → 管理员回复 → Topic 出现一次「⚠️ 用户已停止与 Bot 的对话」提示；重复回复不刷屏且仍尝试送达
4. ★ A 解除拉黑再发消息 → 管理员回复恢复送达（A 侧也会看到恢复）
5. ★ 非白名单成员在群 Topic 发言 → 无任何中继
6. 自动化：`outbound-handler` 12 例（校验矩阵/群主 creator 放行/403 置位/恢复闭环/429 重投/400 毒丸）已覆盖上述逻辑

### V6 · S6 管理命令 /ban /unban（★ 人工回归，**待执行**，依赖 V4/V5 完成）

1. ★ 管理员在 Topic A 发 `/ban` → 命令消息被删（用户不可见）+ A 后续消息被静默阻止 + 标题变 🔇
2. ★ 用户 B 全程不受影响
3. ★ `/unban` → A 恢复、🔇 消失（watchlisted 用户则变 ⚠️）
4. ★ 非白名单账号发 `/ban` → 不执行、无任何反应
5. 自动化：`admin-commands` 16 例（parseCommand 纯函数/白名单内外/删消息/图标三态/审计/单一事实源联动）

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
6. 自动化：`admin-danger` 13 例（/purge 与 /deluser 各自的两步确认边界/审计先行顺序断言/墓碑先行/幂等/白名单）

### V9 · S9 管理端点与绑定（★ 人工回归，**待执行**；完成后 S4 手工 seed 可退役）

1. ★ `curl -X POST https://hodor.<子域>.workers.dev/admin/setup -H "Authorization: Bearer <ADMIN_SETUP_SECRET>" -H 'content-type: application/json' -d '{}'` → 成功响应（空体回退 env）；此后 getWebhookInfo 与 `/admin/webhook/status` 一致
2. ★ 绑定后用户消息照常入站（链路不回归；手工 seed 的 bots 行被 setup 的 upsert 接管）
3. ★ `/admin/admins` 增删管理员 → 生效且审计可查（db 或审计查询）
4. ★ （可选）`/admin/webhook/unbind` → 重绑恢复；错误 Bearer → 401；1 分钟内 >10 次 → 429
5. 自动化：`admin-endpoints` 11 例（setup 全链路/幂等/回退/限速/审计无敏感值）

### V10 · S10 终验：docs/10 全部 21 条真机场景（★ 人工回归，**待执行**，依赖 V4–V9 完成）

> docs/10「集成测试（真机）」21 条的执行清单。每条标注：必做/顺延、对应 V 小节步骤、判定要点。实际结果由执行人逐条记录到
> `.trellis/tasks/09-28-s10-acceptance/acceptance-report.md`（或任务工件）。
> 12/17/18 为换绑/灰度类，**换绑实际发生时补做**；其余 18 条必做。

**分期执行建议**（依赖关系决定顺序，危险命令最后做）：

| 期 | 前提 | 执行内容 |
|---|---|---|
| 第一期 | V4 完成（准备 6 步 + 5 项验证通过） | 场景 1–2、10–11（入站基础 + 幂等） |
| 第二期 | V5–V7 完成 | 场景 3–9、13–16、20（双向中继 + /ban /unban /risk） |
| 第三期 | V8–V9 完成（**V8 不可逆命令放最后**） | 场景 19、21（/purge /deluser 演练） |
| 顺延 | 换绑/灰度实际发生时 | 场景 12、17、18 |

**逐条清单**：

| # | 场景（docs/10 原文摘要） | 状态 | 对应节 | 判定要点 |
|---|---|---|---|---|
| 1 | 用户 A、B 同时发送消息 | 必做 | V4 验证 1/3 | 两条都进群 |
| 2 | 确认分别进入 Topic A、Topic B | 必做 | V4.4 | 各自 Topic、标题 `👤 昵称 完整ID · #序号` |
| 3 | 管理员分别回复 | 必做 | V5.1 | 在 Topic 内直接回复任意消息即可 |
| 4 | 确认回复回到正确用户 | 必做 | V5.1 | A/B 各收到自己 Topic 的回复，不串线 |
| 5 | 在 Topic A 执行 /ban | 必做 | V6.1 | 命令消息即被删除 |
| 6 | 确认 A 后续消息被阻止且标题显示 🔇 | 必做 | V6.1 | A 再发无响应，标题 🔇 |
| 7 | 确认 B 不受影响 | 必做 | V6.2 | B 照常收发 |
| 8 | 在 Topic A 执行 /unban | 必做 | V6.3 | 命令消息被删 |
| 9 | 确认 A 恢复且 🔇 消失 | 必做 | V6.3 | 标题恢复 👤（watchlisted 则 ⚠️），消息照常中继 |
| 10 | 重复发送同一 Update（重放 inbox payload） | 必做 | V4 验证 5（curl 重放） | 200，无新登记 |
| 11 | 确认没有重复创建 Topic 或重复发送 | 必做 | V4.6 | Topic 数、WELCOME 数不变 |
| 12 | 解绑/重绑和灰度更新期间确认不丢 Update | 顺延 | V9.4（unbind 缺省保留积压） | 重绑后积压 Update 补投不丢 |
| 13 | 用户 A 拉黑 Bot → 管理员回复 → 「无法送达」提示 | 必做 | V5.3 | Topic 出现一次提示，重复回复不刷屏 |
| 14 | 用户 A 解除拉黑并再发消息 → 标志清除、回复恢复 | 必做 | V5.4 | 恢复提示出现，回复可达 |
| 15 | 非白名单成员在支持群 Topic 发言 → 无任何中继 | 必做 | V5.5 | 群内无反应、用户私聊无反应 |
| 16 | 制造 429（短时间大量发送）→ 退避后仍全部送达 | 必做 | V5.6（连发数十条触发限流） | 无丢失；`getWebhookInfo` 无堆积 |
| 17 | 换绑演练：归档台账并绑定新 Bot → 老用户进原 Topic | 顺延 | 归档台账 SQL：`DELETE FROM inbox_updates WHERE status IN ('processed','failed')`（先核对 pending=0，D1 Console 执行）+ docs/05 Runbook | 历史连续、Topic 不新建 |
| 18 | 换绑演练：新 Bot 低位 update_id 不被旧台账幂等命中 | 顺延 | 同上 | 新消息正常处理 |
| 19 | /purge 演练（两步确认） | 必做 | V8 /purge 1–3 | 整题删除、D1 无残留、General 公告、审计含 purge；再发消息同 #序号新题 |
| 20 | /risk 演练（⚠️、WATCH_NOTICE 24h、与 /ban 正交、/unrisk） | 必做 | V7.1–V7.4 | 全链路按 V7 判定 |
| 21 | /deluser 演练（两步确认、墓碑） | 必做 | V8 /deluser 4–5 | 全删、General 公告、审计含 deluser；再发无响应，/start 后新序号恢复并继承高危标记 |

**附带实测项（终验时顺带，一次即可）**：手动 close 一个**未封禁**测试用户的 Topic → 该用户在 Bot 私聊发一条消息（入站 copyMessage 会写入该 Topic）→
消息出现在该 closed Topic，则 `CLOSE_TOPIC_ON_BAN` 选项（`src/pipeline/commands/ban.ts` TODO）可在后续版本启用；
若 Telegram 报 TOPIC_CLOSED 类错误，则永久移除该选项并删除 TODO（决策记录见 acceptance-report.md 第三节）。
⚠️ 判定主体是 **Bot**（copyMessage 的写入方），不是人类管理员——管理员自己能在 closed Topic 发言不代表 Bot 可以。

### 部署后的更新与回滚（三条路径通用）

- 源码更新走 push 自动部署（路径三则手工 deploy）；**不再点按钮 / 不再重复导入**
- 回滚：Dashboard → Deployments 一键回退（秒级）或 `npx wrangler rollback`；**Worker 回滚不回滚 D1**，迁移始终 append-only（docs/08）
- 默认全量生效；需要灰度时用 Dashboard → Deployments → 版本上线控制（Versions gradual deployments，如 1% → 10% → 50% → 100%），任一阶段异常立即回退 Worker 版本（docs/08「滚动发布」）；灰度期间新旧版本共用兼容 Schema 与状态值
- Webhook URL、Secrets、D1 资源跨更新原样保留（发布不重设 Webhook，docs/08）
- Bot 行为的人工验证从 S4 开始（首条真实消息建 Topic）；S1 阶段远端验证的是部署链路与 `/health`

## 运维（docs/09 约定）

- 管理端操作不封装脚本，直接调 `/admin/*` 端点（docs/05），Bearer `ADMIN_SETUP_SECRET`（S9 起可用）

### 数据库巡检（Dashboard D1 Console）

**唯一查询途径**：Dashboard → Storage & Databases → D1 → `hodor` → Console，直接输入 SQL 执行。现成查询集见 [scripts/d1-console.sql](scripts/d1-console.sql)：8 张表的常用查询（客户 / Bot 绑定 / 管理员 / 会话与 Topic 映射 / 消息截断 / inbox 状态机总览 / 失败队列 / 审计 / 已删除用户 / 会话活跃度 Top 20），整段或单条粘贴执行。

只读约定（docs/09）：只固化只读查询，不封装任何写操作或管理操作（管理走 `/admin/*` 端点）；消息正文属敏感数据，直查结果不外发、不贴日志。
