# 原理与架构

## 总览

```
                        Telegram
             ┌──────────┐    │    ┌──────────────┐
             │ 用户私聊  │    │    │  超级群组      │
             │ (bot DM) │    │    │  (topics)     │
             └────┬─────┘    │    └──────┬───────┘
                  │ update   │           │ update
                  │ (Webhook)│           │ (Webhook)
                  ▼          │           ▼
             ┌─────────────────────────────────┐
             │         Cloudflare Worker        │
             │   /webhook ← Telegram 推送入口    │
             │   路由层 → pipeline → store       │
             │              ↓         ↑         │
             │        telegram client (API)     │
             └───────────────┬─────────────────┘
                             │ SQL
                             ▼
                       ┌──────────┐
                       │  D1 数据库 │ （六张表）
                       └──────────┘
```

入站（用户 → 群组）与出站（群组 → 用户）共用同一个 `/webhook` 入口，由消息来源分流：私聊消息走入站管线；来自 `SUPPORT_CHAT_ID` 且带 `message_thread_id` 的消息走出站管线。

## 发布与更新

发布与更新链路（Release Please 自动发版、fork 用户手动跟随）已独立成页，见[发布与更新](/guide/release.md)。

## 端点与鉴权

| 端点 | 方法 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `/webhook` | POST | `X-Telegram-Bot-Api-Secret-Token` 头 == `TELEGRAM_WEBHOOK_SECRET` | Telegram update 唯一入口 |
| `/setwebhook/<ADMIN_SECRET>` | GET | `ADMIN_SECRET`（路径段） | 绑定 webhook，token 从 env 读取 |
| `/deletewebhook/<ADMIN_SECRET>` | GET | 同上 | 解绑 webhook |
| `/health` | GET | 无 | 部署完整性自检 + 版本号 |

::: info 鉴权失败的响应约定
管理端点的所有鉴权失败（secret 缺失、不存在、不正确）一律返回 `401` + 「无效的管理密钥」，**不区分具体原因**，避免给探测者反馈某个 secret 是否存在过。`/webhook` 的 secret 头不符同样只返回 `401`，不携带任何区分信息。
:::

### /health 自检项

部署完成后访问 `/health` 即可确认整条链路就绪，逐项检查并返回 JSON（不回显任何密钥值）：

| 检查项 | 内容 |
| --- | --- |
| 环境变量 | 必填变量已配置且格式合法（如 `SUPPORT_CHAT_ID` 以 `-100` 开头） |
| 数据库 | `HODOR_DB` 绑定可用、六张表已建（迁移已执行） |
| Webhook 绑定 | 通过 `getWebhookInfo` 确认 webhook 已指向本 Worker 的 `/webhook` |

- 全部通过：`{"status":"ok","version":"x.y.z"}`
- 有未通过项：`{"status":"error","version":"x.y.z","failed":["...逐项失败原因..."]}`（如「webhook 未绑定，请访问 `/setwebhook/<ADMIN_SECRET>` 完成绑定」）

### 三种密钥的分工

| 密钥 | 方向 | 作用 |
| --- | --- | --- |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram → Worker | `setWebhook` 的官方 `secret_token` 参数；此后每条 update 携带专用请求头，Worker 校验，防止任何人伪造 POST 冒充 Telegram |
| `ADMIN_SECRET` | 管理员 → Worker | 管理端点的访问凭证，作为 URL 路径段使用，浏览器可直接访问 |
| `TELEGRAM_BOT_TOKEN` | Worker → Telegram | bot 身份凭证，仅存环境变量，永不进 URL / 日志 |

## 消息流水线

### 入站（用户 → 群组 topic）

```
update 到达
 │ ① 校验 secret 头
 │ ② processed_updates 幂等去重（重复推送直接 200）
 │ ③ 用户不存在 → 建档（首条消息无论是否 /start 都视为开始，发欢迎语 + 验证码）
 │ ④ 已 ban？ → 回复「你已被禁言」（每用户每分钟 ≤1 次），丢弃
 │ ⑤ 未验证？ → 重发验证码（每用户每分钟 ≤1 次），丢弃
 │ ⑥ 限频：60 秒固定窗口计数 ≥ MAX_MESSAGES_PER_MINUTE？
 │      → 标记未验证 + 发新验证码，丢弃
 │ ⑦ 确保 topic：查 topics 表；无则 createForumTopic + 置顶用户信息；
 │      deluser 过的用户 → 重开原 topic
 │ ⑧ sendMessage 中继文本到 topic（阶段 3 起扩展媒体）→ 返回 200
```

### 出站（群组 topic → 用户）

```
update 来自 SUPPORT_CHAT_ID 且带 message_thread_id
 │ ① 幂等去重
 │ ② 发言者 ∈ ADMIN_IDS？否 → 静默忽略
 │ ③ 以 / 开头？ → 按管理命令处理（命令表见功能介绍）
 │ ④ 普通消息：thread_id 反查 topics → user
 │      查无用户（僵尸 topic）→ 在 topic 内提示管理员手动处理
 │ ⑤ sendMessage 私聊送达（messages 账本 T25 落库）→ 返回 200
```

## 验证状态机

```
          首条消息 / 重新 start
  [新建] ───────────────▶ [待验证] ──答题正确──▶ [已验证]
                              ▲                      │
                              │   限频超限 / VERIFY_TTL 过期
                              └──────────────────────┘
                              ▲
                              │ /deluser（同时关闭 topic）
                              └──────────────────────┘
```

- 验证码：`a ± b` 题目 + 4 个答案按钮，正确答案只存数据库，callback 只携带用户所选值，不在消息里泄漏答案
- 答错：编辑原消息提示错误，并重新出一题
- 验证通过前的消息直接丢弃，不积压补发

## 可靠性

- **幂等**：Telegram webhook 是至少一次（at-least-once）投递，同一 update 可能重推。`processed_updates` 表按 `(bot_id, update_id)` 去重
- **重推**：处理过程抛错时返回非 200，Telegram 会自动重新推送
- **防毒丸**：同一条 update 失败次数超过 `MAX_ATTEMPTS` 后标记 `failed` 跳过，避免坏消息无限循环
- **429**：调 Telegram API 遇 429 时按 `retry_after` 等待后原地重试一次

## 分层设计

四层各自回答一个问题，逐层委托：

| 层 | 回答的问题 | 职责 |
| --- | --- | --- |
| 路由层 | 这个请求是谁、合法性如何、交给谁 | 端点分发、鉴权、HTTP 响应码（200 / 401 / 500） |
| pipeline | 这条消息的业务流程是什么 | 入站、出站、命令三条处理管线，纯业务编排（即上方两张流程图的 ①–⑧ / ①–⑤ 步） |
| store | 数据怎么读写 | D1 访问收敛为按表划分的模块，pipeline 不写裸 SQL |
| telegram client | 怎么调 Telegram API | API 调用与错误分类（可重试 / 永久）的唯一出口 |

层间单向依赖：路由 → pipeline → store / telegram client，低层不反向调用高层。

对应到代码组织：

```
src/
  index.ts          # fetch 入口（路由层分发）
  routes/           # webhook / setwebhook / health 各端点
  pipeline/
    inbound.ts      # 入站管线：用户私聊 → topic
    outbound.ts     # 出站管线：topic → 用户
    commands.ts     # 命令管线：管理命令处理
  store/            # users / topics / messages / settings 按表分模块
  telegram/         # client.ts：API 调用与错误分类的唯一出口
```

这样分层的直接收益是**可测试性**：pipeline 不写裸 SQL、不直接发 HTTP——数据操作全走 store 函数、Telegram 调用全走 client，验证规则、限频逻辑等核心业务可以 mock 这两个依赖做单元测试。同时路由层保持极薄，调整鉴权方式或增删端点（如管理端点从查询参数改为路径段）不影响业务流程。

## 关键设计决策

| 决策 | 理由 |
| --- | --- |
| 媒体 file_id 直传，不落盘 | `sendPhoto`/`sendVideo` 等按 file_id 原样发送任何类型（T22，阶段 3）；零存储成本、零 R2 依赖，部署门槛最低。代价是 Telegram 服务端为唯一存储（可接受，不做本地留存） |
| token 永不进 URL | URL 会留在浏览器历史、CF 访问日志等处，泄漏即被接管 bot。管理端点用独立的 `ADMIN_SECRET` 鉴权，token 只从 env 读取 |
| 一人一 topic，deluser 后复用 | 管理员在同一个 topic 看到该用户完整历史；群组不堆积僵尸 topic；省去「新建 topic 重名」和墓碑表的复杂度 |
| 全表带 bot_id | v1 单 bot，但数据模型天然支持多 bot：未来按 bot 独立 webhook 路径接入时只改接入层，不动数据 |
| 无框架，原生 fetch | 端点总共只有 4 个，引入 Web 框架收益极低；零运行时依赖也让免费额度占用最小 |
| 提示回复限频（每用户每分钟 1 次） | 防止攻击者用「垃圾消息 → 触发提示回复」反向刷 CF 请求额度 |

## 路线图

见 [TODO](/todo/index.md)：P2 多 bot 运行时 / 换绑迁移 / TGuard 验证。

## 参考项目

hodor 的设计借鉴了以下开源项目：

| 项目 | 借鉴点 |
| --- | --- |
| [iawooo/ctt](https://github.com/iawooo/ctt) | 数学题验证码 + 答案按钮、分钟级限频超限重验、D1 + topic 映射的整体形态 |
| [SideCloudGroup/BetterForward](https://github.com/SideCloudGroup/BetterForward) | topic 置顶用户信息、管理命令设计（ban / 高危标记 / 清理会话） |
| [wozulong/open-wegram-bot](https://github.com/wozulong/open-wegram-bot) | 无状态转发思路、webhook `secret_token` 鉴权 |
