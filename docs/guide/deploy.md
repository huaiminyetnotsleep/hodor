# 部署流程

## 准备工作

1. **申请 bot**：Telegram 中找 [@BotFather](https://t.me/BotFather) → `/newbot`，按提示完成后记下 bot token
2. **创建超级群组**：新建群组 → 群设置中开启「话题」（Topics）功能
3. **获取群 chat_id**（`-100` 开头），三种方式任选：
   - 邀请 [@sc_ui_bot](https://t.me/sc_ui_bot) 进群，发送 `/id`
   - 使用 [@getidsbot](https://t.me/getidsbot) 获取
   - 让 bot 进群后发一条消息，浏览器打开 `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`，记下 `chat.id`
4. **把 bot 拉进群并设为管理员**，至少授予以下权限：
   - 发送消息
   - 管理话题（创建 / 关闭 / 删除 topic）
   - 删除消息（`/purgemsg` 需要）

## 环境变量

| 变量 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Secret | ✅ | — | bot token，仅存环境变量，永不进 URL |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | ✅ | — | 绑定 webhook 时传给 Telegram 的官方 `secret_token`（≥16 位，字母数字下划线连字符）；此后每条 update 都带专用请求头用于防伪造 |
| `ADMIN_SECRET` | Secret | ✅ | — | `setwebhook` / `deletewebhook` 管理端点的访问凭证 |
| `SUPPORT_CHAT_ID` | Var | ✅ | — | 超级群组 ID（`-100` 开头） |
| `ADMIN_IDS` | Var | ✅ | — | 管理员 Telegram 用户 ID，逗号分隔，支持多个 |
| `MAX_MESSAGES_PER_MINUTE` | Var | — | `20` | 每用户每分钟转发上限，超限触发重新验证 |
| `VERIFY_TTL_HOURS` | Var | — | `0` | 验证有效期（小时），`0` = 永久 |
| `MAX_ATTEMPTS` | Var | — | `3` | 同一条 update 处理失败的最大重试次数，超限标记失败跳过 |

::: warning
三个 Secret 请使用**互不相同**的长随机串。
:::

## 部署方式：GitHub 集成（一键部署）

全程在浏览器中完成，无需本地环境：

1. **Fork 本仓库**
2. **连接 Git**：dashboard → Workers & Pages → Create → Workers → 连接你 fork 的仓库，生产分支选 `main`
3. **配置环境变量**：Settings → Variables 中按上方表格逐项配置
4. **部署**：保存后自动触发首次部署；之后每次 push 到 `main` 即自动发布新版本

D1 数据库的创建与绑定（变量名 `HODOR_DB`）、数据表迁移全部由部署脚本自动完成，无需在 dashboard 手动操作。环境变量在 dashboard 配置后不会被后续部署覆盖（wrangler 配置开启了 `keep_vars`）。

## 部署后收尾

1. **自检**：浏览器打开 `https://<worker-url>/health`，确认环境变量、数据库检查通过（此时 webhook 项显示未绑定属正常）
2. **绑定 webhook**：浏览器打开 `https://<worker-url>/setwebhook/<你的 ADMIN_SECRET>`（详见[运维手册](/guide/ops.md)）
3. **复查**：再次访问 `/health`，全部通过时返回成功与版本号
4. 用 Telegram 账号给 bot 发 `/start`，应收到欢迎语 + 验证码
5. 完成验证后，消息应出现在群组新建的 topic 中；管理员在该 topic 里回复，用户应收到私聊消息

## 后续如何更新

部署实例默认**手动**跟随官方更新，官方发版不会自动改动你的实例：

1. 收到官方 Release 通知（可在官方仓库点 **Watch → Releases**）
2. 打开你 fork 的 GitHub 页面，点 **Sync fork**（无需终端）
3. 你的 Cloudflare 自动构建部署，数据库迁移自动执行
4. 访问 `/health` 确认自检全绿、版本号已更新

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 部署后 bot 无响应 | webhook 未绑定；或 `TELEGRAM_WEBHOOK_SECRET` 与绑定时不一致（update 校验 401），重新执行 setwebhook |
| 消息进了群但没建 topic | bot 缺少「管理话题」权限 |
| `/purgemsg` 执行失败 | bot 缺少「删除消息」权限 |
| 突然全部请求 429 | CF 免费套餐每日 10 万请求上限用尽，见[运维手册 · 故障排查](/guide/ops.md#故障排查) |
