# 05 · Webhook 管理与初始化

> **hodor 设计文档 · 05/13**
> 上一篇:[04-admin-commands](04-admin-commands.md) · 下一篇:[06-data-model](06-data-model.md) · [返回总览](README.md)

---

## 概念:Bot Token、Webhook Secret 与管理端 Secret

```text
Bot Token
= 调用 Telegram Bot API 的密码

Webhook Secret
= setWebhook 的 secret_token 参数
= Telegram 请求头中的 X-Telegram-Bot-Api-Secret-Token
= 只用于验证 Webhook 请求来源(数据面:Telegram → Worker)

Admin Setup Secret
= 调用 /public/setwebhook、/public/deletewebhook 管理端点的凭证(管理面:管理员 → Worker)
= 与 Webhook Secret 必须是两个不同的值
```

三者绝不放入 URL、前端或普通日志。

**Phase 1 存储(env 与 `bots` 表的共存规则)**:

- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`、`ADMIN_SECRET` 全部放 **Worker Secrets(env)**,这是 Phase 1 的运行时事实源;
- `bots` 表仍存在,由初始化流程 seed(记录 `telegram_bot_id`、`webhook_key`、`support_chat_id`、`webhook_secret_hash` 等),供外键与查询使用;**`encrypted_bot_token` 允许为 NULL**——多 Bot 主密钥加密体系是 Phase 4 的事,Phase 1 不实现。

## Secret 校验实现

存储与比较均用哈希,避免明文落库与时序侧信道:

```text
存储:webhook_secret_hash = SHA-256(secret)
校验:SHA-256(请求头值) == 存储的哈希
不匹配 → 401,不做任何业务处理、不留任何业务日志
```

Phase 1 运行时的 secret 来自 env,校验为 `SHA-256(header) === SHA-256(env)`。

## 管理端凭证:ADMIN_SECRET 的配置与用途

`ADMIN_SECRET` 保护的是**管理面**——管理员调用 `/public/setwebhook`、`/public/deletewebhook` 端点的能力。它**不是网页登录密码**(Phase 1 没有任何网页):所谓管理端,就是一组直接可调的 HTTP API。

**什么时候用**(全部是低频运维动作,与消息链路 `/telegram/webhook/:key` 无关):

| 场景 | 端点/途径 | 频率 |
|------|----------|------|
| 首次部署/初始化:验证 Token(读 Secret)、seed bots 行、同步白名单、`setWebhook` + `setMyCommands` | `POST /public/setwebhook` | 基本一次 |
| 重绑/换配置(setwebhook 为 upsert 语义) | `POST /public/setwebhook` | 偶尔 |
| 白名单增删(改 `ADMIN_IDS` 后重跑) | `POST /public/setwebhook` | 人员变动时 |
| 解绑 Webhook(下线/迁移) | `POST /public/deletewebhook` | 罕见 |
| 排障:查看 Webhook 状态(URL / pending / last_error) | 直接调 Telegram `getWebhookInfo`(Token 在部署者手里,无需 Worker 端点);`GET /health` 只验 Worker 活性 | 需要时 |

**怎么配置**(Worker Secrets:加密注入运行时 `env`):

```bash
# 生产:设置后不可读回,代码统一从 env.ADMIN_SECRET 取值
wrangler secret put ADMIN_SECRET

# 本地:写入 .dev.vars(必须 .gitignore,不入库)
```

- **禁止**写入 `wrangler.toml` 的 `[vars]`——明文随代码进仓库等于把钥匙提交进 Git;
- 轮换该值后改 env 即生效;若同时轮换了 `TELEGRAM_WEBHOOK_SECRET`,需重跑 `/public/setwebhook` 让 `setWebhook` 带上新值。

**怎么携带与校验**:

- 请求头携带:`Authorization: Bearer <ADMIN_SECRET>`;**绝不放 URL / 查询参数**;
- Worker 与 env 值比对,不匹配 → `401`,不做业务处理、不留业务日志(与 Webhook Secret 同一原则);
- 端点做基础限速防探测;成功的变更操作写 `audit_logs`。

**与 Webhook Secret 的分工**:

| 维度 | `TELEGRAM_WEBHOOK_SECRET` | `ADMIN_SECRET` |
|---|---|---|
| 方向 | Telegram → Worker(数据面) | 管理员 → Worker(管理面) |
| 验证目标 | 请求确实来自 Telegram | 调用者确实是管理员 |
| 频率 | 每条消息投递 | 低频运维调用 |
| 轮换 | 改值后必须重新 `setWebhook` | 改 env 即时生效 |

二者必须是**不同的值**——一个泄露不扩大另一个的攻击面。

## 前置准备清单(Telegram 侧,部署前一次性完成)

本节产物 = 三个值(Bot Token、支持群 `chat_id`、管理员 `user_id` 列表)+ 两个自定 Secret。Token 与两个 Secret 走 Secret 存储;`chat_id` 与管理员列表属**非敏感配置**,走普通环境变量——部署表单合计 5 项(另有 1 个选填变量有代码缺省,一般不动),去向见下方汇总表与「初始化与绑定流程」。

### 1. 创建机器人(BotFather)

1. 与 @BotFather 对话 `/newbot`,取名与用户名(必须 `bot` 结尾),获得 **TELEGRAM_BOT_TOKEN**——只进 Secret 存储,不入代码、不入文档;
2. `/setprivacy` → **Disable**:群管理员 Bot 本就能收到全部消息(privacy mode 对管理员无效),关掉属于防御性冗余——即使日后误失管理员身份,中继也不至于静默失联;
3. 可选:`/setdescription`、`/setabouttext`、`/setuserpic`(对外形象,与链路无关);
4. Token 丢失或泄露走 BotFather `/revoke` 重新生成(跨 Bot 换绑 Runbook 同款操作)。

### 2. 创建支持群并配置

1. Telegram 内新建群组(创建时至少拉入一名其他成员,建后可移除);
2. 群设置 → 开启「话题 / Topics」——开启时 Telegram 自动把普通群升级为超级群(`is_forum = true`,运行规格见 [02](02-forum-routing.md));
3. 群设置 → **保持无公开用户名**(私有群);**不开启「限制保存内容」**(protected content)——红线,会使 `copyMessage` 链路中断(见 [09](09-security-ops.md));
4. 把 Bot 拉入群并**提升为管理员**,权限按 [02](02-forum-routing.md) 权限表勾选:Manage Topics / Send Messages / Delete Messages / Pin Messages(可选)。管理员身份同时是「Bot 收到全部群消息」的前提——这比 privacy 设置更关键;
5. `General` Topic 为群自带话题(`message_thread_id = 1`),规划为公告区,不绑用户(见 [02](02-forum-routing.md))。

### 3. 取 ID(绑 Webhook 之前)

此刻 Bot 尚未绑定 Webhook,`getUpdates` 可用(绑 Webhook 后调用会返回 409 冲突,所以取 ID 必须前置):

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

- 让每位管理员在支持群里各发一条消息,返回的 `message.chat.id` 即支持群 **chat_id**(`-100` 开头的负数),`message.from.id` 即各管理员的 **user_id**(正整数);
- 管理员 user_id 是 `support_admins` 白名单的来源——随 `/public/setwebhook` 写入;后续增删 = 改 `ADMIN_IDS` 环境变量后重跑 setwebhook 全量同步(见下文「管理员白名单」);管理员还应同时是支持群的群管理员,两者定期核对是 [09](09-security-ops.md) 的安全清单项;
- 也可用任一第三方 ID 查询 Bot 代替,信任自担。

### 4. Secret 与 ID 汇总

| 变量 | 必填 | 用途 | 来源 | 去向 |
|------|------|------|------|------|
| `TELEGRAM_BOT_TOKEN` | **必填** | Bot API 调用凭证:setWebhook、copyMessage、Topic 管理全靠它 | 步骤 1 BotFather | `wrangler secret put` / 按钮 Secret 表单 |
| `TELEGRAM_WEBHOOK_SECRET` | **必填** | 数据面鉴权:校验 Telegram 回调头(SHA-256 比对);三个 Secret 必须互异 | 自定随机值,建议 `openssl rand -hex 32` | 同上;setwebhook 时经 `setWebhook` 注入 Telegram |
| `ADMIN_SECRET` | **必填** | 管理面鉴权:调用 `/public/setwebhook`、`/public/deletewebhook` 时作 Bearer | 自定随机值,**与上一个不同** | 同上 |
| `SUPPORT_CHAT_ID` | **必填** | 私有支持群 chat_id(`-100` 开头):Topic 所在群,双向路由依据 | 步骤 3 | 部署表单普通变量(非敏感) |
| `ADMIN_IDS` | **必填** | 管理员白名单(逗号分隔):setwebhook 时全量同步进 `support_admins` | 步骤 3 | 部署表单普通变量(非敏感) |
| `MAX_ATTEMPTS` | 选填(缺省 8) | inbox 处理尝试上限,超限转人工 DLQ(见 [03](03-message-pipeline.md)) | 代码缺省即可 | 可选环境变量 |

三个 Secret 绝不相互复用、绝不入 Git;Telegram 侧准备就绪后,进入「初始化与绑定流程」或「一键部署」。

## 初始化与绑定流程

```text
┌──────────────┐   ADMIN_SECRET    ┌──────────┐
│ 管理员管理端  │ ─────────────────────> │ Worker   │
└──────────────┘   请求体可空(缺省读 env) └────┬─────┘
                                             │ getMe(验证 Secret 中的 Token)
                                             ▼
                                      seed/更新 bots 行
                                      (telegram_bot_id, support_chat_id,
                                       webhook_secret_hash, status=active)
                                             │
                                             ▼
                                      写入管理员白名单(support_admins 全量对齐 = ADMIN_IDS 镜像)
                                             │
                                             ▼
                              setWebhook
                                url = https://<worker>/telegram/webhook/<webhook_key>
                                secret_token = <secret>
                                allowed_updates = ["message"]
                                             │
                                             ▼
                              setMyCommands(support 群 scope,管理命令菜单,非致命,见 04)
                                             │
                                             ▼
                                      getWebhookInfo(核对 URL / pending / last_error)
                                             │
                                             ▼
                                      写 audit_logs(action = webhook_bind)
```

- 管理端本身用 `ADMIN_SECRET`(或 Cloudflare Access)保护,端点做基础限速防探测;
- `webhook_key` 是随机标识符,只用于 URL 混淆,不承担鉴权(鉴权靠 Secret 头);
- Webhook URL 长期稳定,**发布新版本 Worker 不重设 Webhook**(见 [08](08-reliability.md))。

### 实操:两个管理端点的调用示例(Phase 1 无 UI,端点即运维接口)

`<worker-domain>` 为 Worker 公网域名(如 `<name>.<account>.workers.dev`);Secret 从环境变量读入,不写进脚本(见文末「运维方式」)。

```bash
# ① 绑定(upsert:首次初始化、换配置、白名单同步共用;空请求体,配置全部读 env)
curl -X POST "https://<worker-domain>/public/setwebhook" \
  -H "Authorization: Bearer $ADMIN_SECRET"
# Worker 内部依次:getMe 验证 env Token → seed/更新 bots 行 → 白名单全量对齐
#   (support_admins 表同步为 ADMIN_IDS 的镜像,差集写 admin_add/admin_remove 审计)
#   → setWebhook(url = 本 Worker 的 /telegram/webhook/<webhook_key>)
#   → setMyCommands → getWebhookInfo 核对 → 写审计
#
# 语义注意:配置的唯一通道是 env——修改 SUPPORT_CHAT_ID / ADMIN_IDS 后重跑 setwebhook 即生效;
# 白名单没有独立端点(增删 = 改 env + 重跑)。

# ② 解绑(下线/迁移;默认保留 Telegram 侧积压)
curl -X POST "https://<worker-domain>/public/deletewebhook" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "drop_pending_updates": false }'
```

要点:

- **端点命名与 PRD 一致**(`setwebhook` / `deletewebhook`);`/public` 前缀为固定字面量路径(沿用 PRD 默认值,不做配置项),不承担鉴权——鉴权全靠 Bearer;
- **排障不需要 Worker 端点**:Webhook 状态直接调 Telegram `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`(Token 在部署者手里);`GET /health` 只回答「Worker 活着吗」,不透出 Telegram 侧状态——两者不是一回事;
- **全程不碰 BotFather**:BotFather 不管理 Webhook;`setWebhook` / `deleteWebhook` 由 Worker 代你完成;
- Webhook 接收地址确实是 Cloudflare Worker 的公网地址 + `/telegram/webhook/<webhook_key>` 路径,但它由 setwebhook 自动注册给 Telegram,无需抄写;路径里的 `webhook_key` 只是混淆,鉴权全靠 Secret 头。

> 命名注:本组端点按 PRD 定名 `/public/setwebhook`、`/public/deletewebhook`;当前代码实现为 `/admin/setup`、`/admin/webhook/unbind`(另有按本设计移除的 status / admins 端点),收敛与重命名随下一批代码变更执行。

### 参数为什么不放进 URL(安全约定,不做变通)

把参数与 Secret 拼进 URL、"点一下浏览器就执行"看起来省事,但明确禁止:

- **URL 会落进各类日志,请求头与请求体不会**:shell 历史、浏览器历史、反向代理/网关访问日志、报错上报里的完整 URL 都会留存完整链接;`Authorization` 头与 JSON 体不经过这些位置——这正是 Bearer + POST 成为标准做法的原因;
- **带副作用的 GET 会被误触发**:链接预览机器人(包括 Telegram 自己的预览——把链接贴进聊天窗口,预览 Bot 就会 GET 一次)、爬虫、浏览器预取都可能无意触发绑定/解绑。变更操作一律 POST;
- 唯一可直接浏览器打开的 GET 是 `/health`(只读、无敏感信息,用于验活)。

管理端操作(初始化基本一次、解绑罕见)频率极低,直接使用上方 curl 即可;此前评估过的「Makefile 封装」已决策不做——若日后觉得繁琐,更值得做的方向是把运维搬进 Telegram 命令(与 `/ban` 同一套机制),届时单独评审纳入设计。

## 一键部署(Deploy to Cloudflare)与首次引导

前置:Telegram 侧的一次性准备(建 Bot、建群、收集 ID 与 Secret)见上文「前置准备清单」;本节只覆盖 Cloudflare 侧的置备链路。

README 放置部署按钮(仓库地址替换为实际值):

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<org>/hodor)
```

点击后的置备链路:

```text
fork 仓库 → 在自己 fork 的 wrangler.jsonc [vars] 填 SUPPORT_CHAT_ID / ADMIN_IDS(非敏感,随 fork 入库)
        → 点击按钮 → 选账号 → 自动创建 Worker + D1 并完成绑定
        → 按 .dev.vars.example 提示逐项填入三个 Secret
        → 关联 Git 建立 CI/CD(Workers Builds),执行部署命令:
          npx wrangler d1 migrations apply DB --remote && npx wrangler deploy
        → 打开 /health 验活
        → POST /public/setwebhook(空请求体,配置取自环境变量)完成绑定与 setWebhook
```

- `.dev.vars.example` 一职两用:本地开发的变量模板 + 按钮 Secret 清单。注意按钮会把其中**每个未注释条目都当作 Secret** 置备,所以只列三个真 Secret(`TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `ADMIN_SECRET`);
- **非敏感引导配置**(`SUPPORT_CHAT_ID`、`ADMIN_IDS`)放 `wrangler.jsonc` 的 `[vars]`:不含敏感值、可随 fork 入库,fork 者填自己的值;与三个 Secret 合计,部署表单共 5 项;
- **迁移缺口**:按钮只创建 D1 数据库、不执行迁移(官方已知缺口),因此部署命令必须前置 `d1 migrations apply`,见 [01](01-architecture.md) 一键部署设计约束;
- **先有鸡还是先有蛋**:调 `/public/setwebhook` 需要 `ADMIN_SECRET`——该值在按钮的 Secret 填写步骤中一并注入,链条闭合;不走按钮、用 `wrangler deploy` 手工部署时,先 `wrangler secret put` 配好三个 Secret 再调 setwebhook;
- **不采用**「bots 表为空时开放 setup」的自举窗口:公开仓库的部署 URL 可能被第三方抢先初始化;前置注入 Secret 更简单且无竞态;
- 按钮只是入口之一,`wrangler deploy` 手工路径永远保留,两者共用同一套声明式配置。

### 部署后的功能更新:不再点按钮

按钮只负责首次置备;此后源码更新走 Workers Builds 的 push 触发自动部署(推送 → 构建 → 部署),不需要也不应该再点按钮:

- **自有仓库**:提交并 push 到生产分支,即自动触发部署;
- **fork 跟随上游**:本项目(上游)发布更新后,在你 fork 的仓库页点 **Sync fork**(或本地 `git pull upstream main` 后 push),推送即部署;
- 每次部署自动执行部署命令,其中 `d1 migrations apply` 幂等、重复执行安全,Schema 随源码一起演进;Worker 回滚时数据库不回滚,兼容性由 Expand/Contract 规则保证(见 [08](08-reliability.md));
- Webhook URL、Secrets、D1 等资源跨更新原样保留(发布不重设 Webhook,见 [08](08-reliability.md));
- **回滚**:Dashboard → Worker → Deployments 一键回滚上一版本(秒级),或 `npx wrangler rollback`;
- 非 production 分支的 push 产出 Preview 版本(独立预览 URL),可验证后再合入;需要灰度时用 Versions 的 gradual deployments 手动控制。

**不要重复点部署按钮**——那是首次置备流程,重复点击会引导再走一遍资源创建;更新一律走 push。

## 管理员白名单

- **`ADMIN_IDS`(env)是唯一来源**;`support_admins` 表(`UNIQUE(bot_id, telegram_user_id)`,见 [06](06-data-model.md))是运行时镜像(查询用):`/public/setwebhook` 每次执行时**全量对齐**,差集写 `audit_logs`(action = `admin_add` / `admin_remove`);
- 增删管理员 = 面板改 `ADMIN_IDS` → 重跑 `/public/setwebhook`(幂等、低频);**没有独立的白名单维护端点**;
- `/ban`、`/unban` 与出站中继均以 `support_admins` 表为准(见 [03](03-message-pipeline.md)、[04](04-admin-commands.md));
- 群内真实管理员与白名单**定期核对**(见 [09](09-security-ops.md)):群管理员变动时同步改 `ADMIN_IDS` 并重跑 setwebhook。

## 解绑与重绑

```text
deleteWebhook(drop_pending_updates = false)    ← 默认保留积压
```

- 只有明确要丢弃积压消息时才 `drop_pending_updates = true`,并先记录当时 `getWebhookInfo.pending_update_count`;
- 重绑通常直接调用新的 `setWebhook`(upsert 语义),**不必先 delete**;
- 绑定/解绑前后都调用 `getWebhookInfo` 核对:当前 URL、pending 数量、last error、allowed updates;
- 解绑 Webhook **不会**使 Bot Token 失效;Token 泄露只能在 BotFather 重新生成;
- 所有绑定/解绑操作写审计日志(action、时间、操作者;不记录 Token/Secret 值)。

## 换绑机器人(数据零丢失的跨 Bot 迁移)

换到新 Bot(`@newbot`)且保留全部历史,是支持的。三个原理:

- **数据不绑 Token**:customers / conversations / messages / audit_logs 都挂在内部 `bots.id` 上;换绑 = 原地更新这一行(`telegram_bot_id`、`webhook_secret_hash`,`config_version` 递增),外键与数据原封不动;
- **群与媒体不绑 Bot**:支持群、Topic、Topic 内消息与媒体都在 Telegram 侧,与绑定哪个 Bot 无关;新 Bot 以群管理员身份获得同等的 Topic 操作与 `copyMessage` 能力;
- **用户身份是 `telegram_user_id`**:老用户加新 Bot 发消息 → 命中同一 customer / conversation → 在**原 Topic** 继续对话,序号、封禁状态、历史全部连续。

这三条即总览架构原则「Bot 轴与群轴解耦」([01](01-architecture.md))在换绑场景的具体化:换绑 = 替换轴 + 指针切换,pipeline 与历史数据不动。

唯一无法消除的缝:**Bot 用户名必须换**——Telegram 不支持把私聊会话在 Bot 间过户,只能由老 Bot 在下线前逐户发搬家通知;用户主动加新 Bot 后一切照旧。老用户消息不丢的原理:解绑老 Webhook 后 Telegram 仍为该 Bot 缓冲 Update(约 24 小时),绑上新 Webhook 后立即补投。

### 换绑 Runbook

前置:新 Bot 已在 BotFather 创建;`inbox_updates` 无 pending/failed 积压(巡检见 [09](09-security-ops.md))。

```text
① 老 Bot 逐户发送搬家通知(脚本遍历 customers,含新 Bot 用户名 deep link)
② POST /public/deletewebhook(老 Bot 停收;此后 Update 进入 Telegram 缓冲)
③ 归档幂等台账(关键,见下节)——此刻 Worker 无入站流量,是唯一安全窗口
④ wrangler secret put TELEGRAM_BOT_TOKEN(新 Token;若一并轮换 Webhook Secret,setup 时 setWebhook 带新值)
⑤ 新 Bot 拉入支持群,授予与老 Bot 相同权限(Manage Topics / Send / Delete / Pin),老 Bot 移出
⑥ POST /public/setwebhook —— upsert 更新 bots 行(config_version+1)、setWebhook、setMyCommands
⑦ 验证:测试账号发消息 → 落在既有 Topic;getWebhookInfo 的 pending 清零;观察 24–48h
```

收尾:老 Bot 保留 24–48h 兜底迟到者,再在 BotFather 撤销或删除;`audit_logs` 记录本次 webhook_unbind / webhook_bind,`detail_json` 含新旧 `telegram_bot_id`。

### 为什么必须归档台账(关键坑)

`update_id` 序列**每个 Bot 独立递增**。老 Bot 已把 1..N 写入 `inbox_updates`,而新 Bot 的 Update 几乎必然从低位重新开始——不清台账的话,新消息会与旧行命中 `UNIQUE(bot_id, telegram_update_id)`,旧行状态是 processed → **新消息被幂等机制静默吞掉**。步骤 ③ 必须在无流量的窗口内完成:

```sql
-- 先导出备份(Phase 3 起落 R2),再清空已终结行;pending 不为 0 时禁止继续,先排干(见 08)
DELETE FROM inbox_updates WHERE status IN ('processed','failed');
```

### 换绑后老媒体怎么重发

老 Bot 摘到的 `media_file_id` 对新 Bot **失效**(file_id 跨 Bot 不可用)。但历史媒体无损:每条消息在 `messages` 里存有群内副本坐标 `(target_chat_id, target_message_id)`,新 Bot 作为群管理员可随时按坐标 `copyMessage` 重放(见 [07](07-storage.md) T0 层)。失效的只是「按 file_id 直接重发」这一种方式。

双 Bot 并行过渡(老 Bot 继续收、新 Bot 回复)需要多 Bot 架构——Worker 无法区分 Update 来自哪个 Bot,且新 Bot 无法主动私聊未 `/start` 的老用户——属 Phase 4(见 [11](11-roadmap.md)),Phase 1 单 Bot 不采用。

## 多 Bot 架构(Phase 4 · 步骤 20,规划)

Phase 1 单 Bot。多 Bot 是「换绑机器人」能力的完整形态,设计契约([13](13-implementation-steps.md) 步骤 20):

- **Token 入库**:启用 `bots.encrypted_bot_token`(Phase 1 恒 NULL,字段已预留,见 [06](06-data-model.md))——主密钥加密存储,Worker 按行解密调用对应 Bot,Token 不再依赖单一 env;
- **路由隔离**:每个 Bot 独立 `webhook_key` 与 Webhook Secret,Update 按 key 定位 bot 行;幂等命名空间天然按 `bot_id` 隔离(`update_id` 各 Bot 独立递增,见 [03](03-message-pipeline.md));
- **双 Bot 并行过渡**:老 Bot 继续收、新 Bot 回复,消除换绑时「未 `/start` 新 Bot 的老用户无法触达」的缺口(即上节所指 Phase 4 能力);依赖它的无缝迁移/广播已延后(见 [11](11-roadmap.md)「延后意向」);
- 多 Bot 常态化运营的管理台需求,触发条件见「Worker 路由总览」的运维方式决策。

## Worker 路由总览(Phase 1)

```text
POST /telegram/webhook/:webhook_key   → 03 消息管线(Secret 头校验)
POST /public/setwebhook               → 绑定/upsert(ADMIN_SECRET)
POST /public/deletewebhook            → 解绑(ADMIN_SECRET)
GET  /health                          → 健康检查(无敏感信息,见 09)
```

**运维方式(设计决策)**:Phase 1 **不做管理 UI**。管理端点以本文 curl 示例直接调用,Secret 一律从环境变量读入、不写进脚本;**不封装 Makefile/脚本**(操作低频,封装收益小,已评估不做)。升级为 Web 管理台的触发条件——多 Bot、白名单变常态化运营、非技术人员接管、运营看板需求——出现时再立项(Phase 4,见 [11](11-roadmap.md))。表数据查看(用户/消息)同样不建页面、不新增查询端点,以固化只读脚本维护(目标清单见 [09](09-security-ops.md))。

---

下一篇:[06-data-model — D1 数据模型](06-data-model.md)
