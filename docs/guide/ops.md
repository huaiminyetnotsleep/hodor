# 运维手册

## Webhook 绑定与解绑

部署后只需绑定一次。Worker 内部用 env 里的 `TELEGRAM_BOT_TOKEN` 调 Telegram API，token 永不出现在 URL 中。

**绑定**：浏览器直接访问（也可用 curl）：

```
https://<worker-url>/setwebhook/<ADMIN_SECRET>
```

Worker 会把 `TELEGRAM_WEBHOOK_SECRET` 作为官方 `secret_token` 一并注册，成功后页面回显 bot 身份（@username / bot ID）供确认。

**解绑**：同路径换成 `deletewebhook`，即 `https://<worker-url>/deletewebhook/<ADMIN_SECRET>`。

::: tip
访问返回 `401`「无效的管理密钥」表示 URL 路径段与 env 中的值不一致（刚更换过，或复制有误）：核对 dashboard 中的 `ADMIN_SECRET` 后用新链接重试即可。错误提示不区分「不存在 / 不正确」，避免枚举探测。

`ADMIN_SECRET` 泄漏的唯一影响是别人能替你重绑 webhook；随时可在 dashboard 换新值，消息流不受影响。
:::

## 更换 Token

### 情况一：同一个 bot 重新生成 token（如泄漏后 revoke）

bot 身份（bot_id）不变，所有数据继续有效：

1. env 里还是旧 token 时，先访问 `deletewebhook` 解绑
2. dashboard 把 `TELEGRAM_BOT_TOKEN` 换成新值
3. 再访问 `setwebhook` 重新绑定

## 更换 Bot 或客服群 {#switch-bot-or-group}

推荐使用[多个独立实例](/guide/deploy.md#部署多个实例)承接切换，保留旧 Worker、D1 和群组供过渡与查阅。

新实例不会自动复制用户资料、备注、验证状态、话题绑定或消息账本；旧资料留在旧 D1，旧 Telegram 消息仍留在原聊天中。

### 换一个新的 Bot

1. 为新 Bot 部署独立实例并配置独立 D1、客服群和密钥；确认新 Bot 在群内具有所需权限。
2. 给新实例执行 `setwebhook`，核对回显身份和 `/selfcheck`；旧 Bot 的 webhook 保持原样，旧实例继续服务未切换用户。
3. 在旧实例仍可用时，通过现有客服对话或其他已有渠道通知用户新 Bot 地址，引导用户主动启动新 Bot。新 Bot 无法主动私聊尚未启动它的用户。
4. 按需要保留旧实例供未切换用户使用或查阅历史；决定停用时再解绑**旧 Bot** 的 webhook。

新 Bot 中会重新建档、验证和创建话题。建议新旧 Bot 使用不同客服群；同群两个 Bot 对话题、管理命令的隔离尚未实现，不能把它当作已支持的过渡模式。

### Bot 不变，只换客服群

1. 为同一个 Bot 准备新实例与独立 D1，在新实例配置新客服群，并确认 Bot 已加入新群且有话题等必要权限。先不要在新实例执行 `setwebhook`。
2. 安排切换时间；在新实例执行 `setwebhook`，使该 Bot 的唯一 webhook 指向新 Worker。用新实例的 `/selfcheck` 和私聊试消息确认新群能建话题并双向回复。
3. 旧实例和旧群保留供查阅历史。若需回退，在旧实例重新执行 `setwebhook`；**不要**在切换后执行旧实例的 `deletewebhook`，它会删除 Bot 当前指向新实例的 webhook。

用户私聊入口不变，但新 D1 不认识旧用户，首次联系会重新验证并在新群建话题。旧实例不会继续接收这个 Bot 的 update，旧群话题也不会自动搬到新群。

同时更换 Bot 与客服群时，按“换一个新的 Bot”操作，并让新实例使用新群。

## 修改密钥的影响

| 改动 | 影响 |
| --- | --- |
| `ADMIN_SECRET` | 零影响，仅管理端点换钥匙；旧链接失效，用新值重新访问即可 |
| `TELEGRAM_WEBHOOK_SECRET` | 改完**必须重新 setwebhook**：旧注册还带着旧 secret，update 校验会 401 |
| `TELEGRAM_BOT_TOKEN` | 见上方「更换 Token」 |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | 只影响 Turnstile 验证模式；不要只改面板值了事，按下方[验证模式与密钥变更](#验证模式与密钥变更)的门禁顺序操作 |

## 验证模式与密钥变更 {#验证模式与密钥变更}

Turnstile 的申请与生产配置见[部署指南 · Turnstile 申请与配置](/guide/deploy.md#turnstile)（唯一权威流程，本节不重复）。本节只讲运维动作。

### 换密钥或换域名（门禁顺序）

Turnstile 的 Secret、Widget hostname 或 `PUBLIC_BASE_URL` 变更不能只改面板值了事：在途的验证页面与旧配置不会瞬时全局生效。按以下顺序：

1. 管理员在客服群 General 执行 `/verifymode math`（或 `button`）切出 Turnstile 模式——同时作废全部未完成的网页请求
2. 在面板修改变量；hostname 变化时同步在 Turnstile 控制台调整 Widget
3. 访问 `/selfcheck` 复查至无 Turnstile 相关失败项
4. 在客服群 General 执行 `/verifymode_turnstile` 重新启用，并按部署指南的验收步骤在真机复验

### 回滚

在客服群 General 执行 `/verifymode math`（或 `button`）即回退到原模式：未完成的网页请求与旧题目全部作废，**已验证状态保留**，已验证用户无需重验。

不要用直接回滚代码版本的方式「关闭」Turnstile——旧版本不认识新的验证状态字段；先切模式才是安全路径。

## 健康自检与版本

两个公开只读端点，各管一件事：

**`GET /health` — 存活探针 + 版本号**。零外部依赖（不查变量、不查库、不调 Telegram），可供 uptime 监控高频访问：

```json
{"status":"ok","version":"1.1.0"}
```

部署后或每次更新后建议访问一次，确认服务存活并核对版本号。

**`GET /selfcheck` — 完整自检**。按 环境变量 → 验证配置（Turnstile）→ 数据库八表 → Webhook 绑定 的固定顺序逐项检查：

全部通过返回 `200 {"status":"ok","version":"…"}`；有未通过项返回 503 与 `failed` 数组，逐条给出中文失败原因（不回显任何密钥值）。

刚部署、变量还没配齐的新实例也能访问它定位缺失项。

常见 `failed` 项与处置：

| failed 文案（节选形态） | 处置 |
| --- | --- |
| `必填变量未配置：TELEGRAM_BOT_TOKEN、…`、`SUPPORT_CHAT_ID 非法：…`、`密钥变量取值重复：…`、`MAX_ATTEMPTS 已配置但非法（正整数）…` 类 | 面板 Worker → 设置 → 变量和机密 补齐 / 修正对应变量后重试（选填值非法时运行时已回退默认值，failed 项属提示性质） |
| `Turnstile 配置不完整：TURNSTILE_SITE_KEY 与 TURNSTILE_SECRET_KEY 必须成对配置（当前仅配置了 …）` | 两把 Key 成对补齐，或成对清空（不使用 Turnstile）；申请流程见[部署指南 · Turnstile 申请与配置](/guide/deploy.md#turnstile) |
| `当前验证模式为 turnstile，但缺少必需配置：…` | 面板补齐缺失的 Key 后重试；或先在客服群 General 执行 `/verifymode math` / `button` 切回其他模式（验证配置命令仅 General 生效） |
| `TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY 是 Cloudflare 官方测试密钥：仅限本地测试…` | 换成在 Turnstile 控制台创建 Widget 获取的正式密钥（测试密钥放行一切，生产不可用） |
| `PUBLIC_BASE_URL 已配置但非法：必须是 HTTPS origin…` | 修正为合法的 HTTPS origin（仅可含根路径），或直接清空该变量（按请求 origin 自动推导） |
| `验证配置读取失败：无法从数据库读取验证模式（Turnstile 项跳过）` | D1 暂不可用：先看「数据库缺表」类条目与构建日志；该条不阻断其余检查 |
| `数据库缺表：…（迁移可能未执行，请在构建日志确认 migrations 步骤）` | 查看构建日志安装阶段的 `[provision]` 与迁移输出：确认建库 / 复用是否成功、迁移是否执行或失败 |
| `webhook 未绑定，请访问 /setwebhook/<ADMIN_SECRET> 完成绑定` | 浏览器访问 `/setwebhook/<ADMIN_SECRET>` 完成绑定 |
| `webhook 指向错误地址：…（应为 …，请重新执行 /setwebhook）` | 重新执行 `/setwebhook/<ADMIN_SECRET>`（常见于换了 Worker 地址 / 域名后未重绑） |
| `Webhook 状态未知：getWebhookInfo 调用失败（…）`、`Telegram 最近投递错误：…` | Telegram 侧问题：稍后重试；持续出现时检查 token 是否已被吊销、网络策略 |

## 版本管理

发布新版本（维护者）与跟随更新（fork 用户）已独立成页，见[发布与更新](/guide/release.md)。

## 常用 SQL

在 Cloudflare dashboard → Storage & Databases → hodor 数据库 → Console 中直接粘贴执行（`123456789` 替换为目标 user_id）。

完整的运维查询包见仓库 `scripts/d1-console.sql`：总览计数（含活跃广播任务数）、单用户全档案、topic 绑定与归档清单、消息账本（按用户 / 按 topic）、失败 update、settings / bots、孤儿检测、广播任务（活跃 / 滞留），以及隔离在「危险区」段的维护语句。

以下只保留最常用的三条速查，内容与该文件对应条目一致。

**查用户（users 全部状态列 + topic 绑定与备注）**：

```sql
SELECT
  u.user_id, u.first_name, u.last_name, u.username,
  u.status, u.is_banned, u.is_risk, u.is_verified, u.verified_at,
  u.verify_answer, u.verify_msg_id,
  u.rate_window_start, u.rate_count, u.last_notice_at, u.risk_notice_at,
  u.first_seen_at, u.last_seen_at,
  t.thread_id, t.title AS topic_title, t.status AS topic_status,
  t.note, t.pinned_msg_id, t.created_at AS topic_created_at, t.closed_at
FROM users u
LEFT JOIN topics t ON t.bot_id = u.bot_id AND t.user_id = u.user_id
WHERE u.user_id = 123456789;
```

**查某用户的最近消息**：

```sql
SELECT
  direction, content_type, group_msg_id, private_msg_id, created_at
FROM messages
WHERE user_id = 123456789
ORDER BY created_at DESC
LIMIT 50;
```

**查处理失败的 update（毒丸排查）**：

```sql
SELECT
  update_id, attempts, created_at
FROM processed_updates
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;
```

::: warning 维护语句不在此页
清理类 SQL（重置失败 update、按用户清理、一键全清）**没有确认步骤，粘贴执行即生效**，全文集中在 `scripts/d1-console.sql` 的「危险区」段（带醒目警告与影响范围说明）。

日常清理优先使用带两步危险确认的 topic 内命令 `/deluser` / `/wipealldata`（见[功能介绍](/guide/features.md)）。
:::

## 故障排查

| 现象 | 排查 |
| --- | --- |
| `/setwebhook` 回显 `setWebhook HTTP 400: … Failed to resolve host: Temporary failure in name resolution` | Telegram 侧解析不了 webhook 主机名（Hodor 把访问 setwebhook 所用的域名原样注册）：① 确认 Worker 设置 → 域和路由 中 **workers.dev 路由已启用**，且用的是公开 `https://hodor.<子域>.workers.dev` 地址（而非 localhost / 内网 IP / 自定义域）；② 新启用 / 新注册的 workers.dev 子域需数分钟 DNS 传播，`dig <主机名>` 或 dnschecker.org 确认全球可解析后重试 setwebhook（setWebhook 为覆盖式写入，重试安全；2026-10-09 真机验收实测） |
| bot 完全无响应 | ① 先确认 webhook 已绑定：访问 `/setwebhook/<ADMIN_SECRET>` 回显身份即已绑定（或看完整自检 `GET /selfcheck`：未绑定 / 指向错误会在 `failed` 中逐条点名）；② `npx wrangler tail hodor` 实时日志看请求是否到达、有无 401——secret 头不符说明 `TELEGRAM_WEBHOOK_SECRET` 与注册时不一致，重新 setwebhook；③ 日志无请求 = Telegram 侧未推送，检查 webhook 绑定 |
| 消息进群但为空 / 报 sendMessage 400 | `wrangler tail` 看具体 API 报错文案，按 Telegram Bot API 的错误说明定位；权限类问题补齐 bot 群权限后重试 |
| 验证码收不到 | 用户是否已被 ban（封禁门不发出题）；日志中 sendMessage 是否报 403（用户已停用 / 拉黑 bot）；60 秒内重复消息受提示频控限制（每分钟最多 1 次提示） |
| `/verifymode_turnstile` 回复「无法切换…缺少必需配置」 | 面板 Worker → 变量和机密 补齐 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`（成对配置），`/selfcheck` 核对后在客服群 General 重试；申请流程见[部署指南](/guide/deploy.md#turnstile) |
| 验证页面显示「请从 Bot 聊天窗口的…按钮打开本页」 | 链接在 Telegram 外打开（拿不到 Telegram 签名身份）或会话已失效：回到 Bot 私聊点「打开验证页面」按钮重开——这是唯一支持的入口 |
| 验证页面显示「当前账号与验证请求不符」 | 打开链接的 Telegram 账号不是发起验证的账号：让原账号回 Bot 重新发起 |
| 验证页面显示「身份信息已过期（页面打开超过 5 分钟）」 | 页面开着太久：关闭后从 Bot 按钮重新打开；仅刷新挑战组件无效 |
| 验证页面显示「验证链接已过期或已被使用」 | 链接超过 10 分钟或已被使用：回 Bot 发送任意消息获取新链接 |
| 验证页面显示「人机验证未完成，请重新尝试」 | Turnstile 组件加载或校验失败：点「重新验证」；持续失败检查 Turnstile 控制台 hostname 是否包含实际访问域名、设备到 `challenges.cloudflare.com` 的网络是否可达 |
| 验证页面显示「验证服务暂时不可用」 | Cloudflare Siteverify 上游或 Worker 配置异常：稍后重试；用 `/selfcheck` 核对配置，`wrangler tail` 看脱敏日志 |
| 切换模式后旧验证按钮 / 链接还能用吗 | 不能：模式 / 开关真变化会作废全部旧题目与网页请求，切回原模式也不复活；已验证状态保留（详见[验证模式与密钥变更](#验证模式与密钥变更)） |
| 消息转发了但没建 topic，或 topic 操作失败 | bot 在群里缺少「管理话题」权限 |
| `/purgemsg` 执行失败 | bot 缺少「删除消息」权限 |
| 提示「找不到对应用户」 | topic 是僵尸（绑定行不存在或已被手动清理）：按提示手动关闭或删除该 topic |
| `/broadcast` 收件人数超过约 40–50 人时中途停发 / 统计未知 | 检查当前 Worker 每次调用的出站子请求额度：每位收件人至少一次 Telegram API 请求，确认/状态/统计还占额外请求；Cloudflare 免费套餐上限为 50 个普通子请求，无法可靠完成 100–300 人单次广播。需使用足够额度的套餐，并留出限流重试余量；额度与 CPU/请求限制以 Cloudflare 当前套餐为准 |
| `/broadcast` 卡在某一步 | 控制消息停在「待确认」= 预览 5 分钟内未确认（过期自动作废，重新发起即可）；停在「正在发送…」= 请求仍在顺序发送或已中断——`wrangler tail` 看发送日志；超过 10 分钟后任意一次广播操作会把滞留任务标记为「广播中断，结果未知；未自动补发」（不提供恢复操作，重新发起即可）。若 `/wipealldata` 介入，循环会在下一位收件人前停止，但已进入 Telegram 的单条请求无法撤回 |
| `/broadcast` 完成统计里失败偏多 | 失败含三类：用户拉黑 bot（403，Telegram 侧状态，Hodor 不改用户数据）、发送前资格变化（确认后到发送前被禁言 / 删除 / 失去绑定）、限流重试仍失败（429）。可结合 `scripts/d1-console.sql` 的绑定查询与 `wrangler tail` 脱敏日志逐一核对；失败不自动补发，如需重达请重新发起一次广播（重复收到公告的用户以人工权衡） |
| 突然全部请求 429 | Cloudflare 套餐请求配额用尽（免费套餐每日 10 万请求；每条消息约消耗 1 次 CF 请求 + 若干 Telegram API 出站调用）；人机验证默认开启已拦截大部分刷量，可调低 `MAX_MESSAGES_PER_MINUTE`，或升级付费计划 |
