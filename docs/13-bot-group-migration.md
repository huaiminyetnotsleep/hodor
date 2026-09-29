# 13 · Bot 与支持群迁移

> **hodor 设计文档 · 13/13**
> 上一篇:[12-references](12-references.md) · [返回总览](README.md)

本文定义单 Bot 架构向新 Bot、新支持群或二者同时迁移时的目标契约。它是迁移设计与验收依据,不表示当前 Phase 1 已实现双 Bot 过渡、`migration_token`、广播 outbox 或 `legacy_redirect`;这些能力落地时必须另立实现任务,并按 [08](08-reliability.md) 的 Expand / Contract 规则演进。

---

## 无缝迁移的边界

本文所称「无缝」是指:**业务身份、D1 状态、路由关系和可恢复性连续**,而不是突破 Telegram 平台边界把所有界面与消息原样搬走。

可以保证:

- `customer`、封禁/高危状态、审计、D1 消息索引等业务数据不因换 Bot 或换群丢失;
- 切换时只有一个 Bot 和一套路由承担正式业务,避免双收、双发和串线;
- 迁移可分阶段执行、失败可续跑,观察期内保留源端以便回滚;
- 广播、重试和迟到用户引导都有持久化状态,Worker 重启后可继续;
- 每次绑定变化、路由切换、token 消费、回滚与迁移完成均可审计,但日志不记录 Token、Secret 或消息正文。

无法保证:

- **Bot 私聊不能过户**:换 Bot 后,Telegram 不会把用户与旧 Bot 的聊天窗口迁到新 Bot;新 Bot 也不能在用户主动 `/start` 前先私聊该用户;
- **Topic 不能跨群搬迁**:换群必须在新群创建新 Topic;旧群中的 Topic ID、消息 ID 和原生历史仍属于旧群;
- **外部发送不承诺 exactly-once**:切换或重试窗口中,Telegram API 调用仍可能出现极低概率的重复发送,语义遵循 [08](08-reliability.md);
- Telegram 已删除、受 protected content 限制或 Bot 已无权访问的消息/媒体无法强制复制;
- 用户已拉黑旧 Bot、长期未上线或从未点击新 Bot 链接时,只能记录为未触达,不能绕过 Telegram 主动迁移其会话。

因此,验收中的「零丢失」特指**hodor 可控制的数据和状态不丢失**;Telegram 客户端里的私聊窗口与群内原生历史遵循上述平台边界。

## 三种迁移兼容矩阵

| 场景 | 用户侧动作 | Topic 与群历史 | 媒体边界 | 推荐策略 |
|------|------------|----------------|----------|----------|
| **Bot 换、群不变** | 用户必须主动打开新 Bot 并 `/start`;可通过个性化 deep link 降为一次点击 | 原群和原 Topic 可继续使用;切换后仅新 Bot 处理正式业务 | 旧 Bot 的 `file_id` 对新 Bot 失效;新 Bot 仍可在有权限时按原群消息坐标 `copyMessage` | 迁移广播 → 新 Bot 启用 → 旧 Bot 进入 `legacy_redirect` 观察期 |
| **Bot 不变、群换** | 无需重新 `/start`,私聊入口不变 | Topic 不能搬迁;在新群重建 Topic 映射,旧群保留只读历史 | 同一 Bot 的 `file_id` 仍可用;也可从旧群按消息坐标复制,前提是 Bot 仍有访问权 | 先准备新群与 Topic → 原子切路由 → 保留旧群观察后归档 |
| **Bot 和群都换** | 换 Bot 阶段仍需用户主动 `/start` 新 Bot | 群迁移阶段先建立新 Topic;随后换 Bot 时复用新群映射 | 同时受「跨群不能搬 Topic」和「跨 Bot `file_id` 失效」两条约束 | **推荐先换群、稳定后再换 Bot**,不要把两个不可逆边界压进一次切换 |

同时换 Bot 与群时先换群的原因:

1. 旧 Bot 已与全部用户建立私聊关系,可在新群创建 Topic、验证双向中继并发送迁移广播;
2. 群切换失败时可直接切回旧群,不涉及用户重新 `/start`;
3. 新群稳定后再换 Bot,问题域只剩身份入口和 Bot 级媒体句柄,排障与回滚更清晰;
4. 若先换 Bot,尚未迁入新 Bot 的用户无法被新 Bot 主动触达,同时又要重建 Topic,会把触达缺口与路由缺口叠加。

## 统一迁移架构

三种场景共用同一套迁移控制面,只替换 Bot 轴、群轴或两者。以下为纯文本线框图:

```text
┌──────────────┐       私聊 /start / 消息       ┌──────────────────────┐
│ Telegram 用户 │ ────────────────────────────> │ 旧 Bot / 新 Bot        │
└──────────────┘                                │ active 或 redirect-only│
                                                └──────────┬───────────┘
                                                           │ Webhook
                                                           ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Worker                                                                 │
│                                                                        │
│  ┌──────────────┐   ┌────────────────┐   ┌─────────────────────────┐  │
│  │ Webhook 校验  │──>│ 身份与 token 校验│──>│ Migration Coordinator   │  │
│  │ Secret + bot │   │ message.from.id│   │ prepare/cutover/observe │  │
│  └──────────────┘   └────────────────┘   └────────────┬────────────┘  │
│                                                       │               │
│  ┌────────────────────────────────────────────────────▼────────────┐  │
│  │ D1                                                              │  │
│  │ · migration job / generation / active binding                   │  │
│  │ · customer 与旧/新 Bot 绑定别名                                 │  │
│  │ · conversation 与旧/新群 Topic 路由                             │  │
│  │ · migration_token 哈希、过期时间、消费状态                       │  │
│  │ · inbox 幂等、messages、audit_logs、广播 outbox                  │  │
│  └───────────────────────────────┬─────────────────────────────────┘  │
│                                  │                                    │
│                     只有 active generation 可做正式中继               │
└──────────────────────────────────┼────────────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
          ┌──────────────────┐          ┌──────────────────┐
          │ 旧支持群 / 旧 Topic│          │ 新支持群 / 新 Topic│
          │ 保留、只读、可回滚 │          │ 准备后切为 active  │
          └──────────────────┘          └──────────────────┘
```

`active` 与 `legacy_redirect` 是**迁移角色**,不要复用或改写 [06](06-data-model.md) 中 `bots.status = active / disabled` 的既有含义。实际落库时应使用独立的迁移绑定/代际字段,避免把「可接收 Webhook」「正式处理业务」「只做迁移引导」混成一个状态。

## 核心状态约束

1. **单一正式入口**:任一时刻每个部署最多一个 Bot 处于业务 `active` 角色、最多一个旧 Bot 处于 `legacy_redirect` 角色;旧 Bot 进入 `legacy_redirect` 后只能回复迁移提示,不得创建 customer、修改会话状态或转发正式消息。
2. **单一正式群路由**:任一时刻每个部署最多一个支持群处于业务 `active` 角色,全部 active conversation 必须路由到该群;每个 conversation 在该群内最多一个 `(support_chat_id, message_thread_id)` 为 active,旧路由保留为历史/回滚指针,不能继续接收管理员出站中继。
3. **代际栅栏**:Webhook 与异步任务执行前都读取当前 migration generation;旧 generation 的迟到任务只能完成幂等收尾,不得向新代际写正式路由。
4. **先准备、后切换**:目标 Bot 的 Webhook/权限或目标群 Topic 未通过预检前,不得改变 active 指针。外部资源准备允许重复执行,结果必须幂等。
5. **源端延迟删除**:观察期结束前不删除旧 Topic、不移除旧 Bot 权限、不撤销旧 Token;先完成、再观察、最后清理。
6. **幂等隔离**:`inbox_updates` 继续以 `(bot_id, telegram_update_id)` 去重;不同 Bot 的 `update_id` 绝不共享同一幂等命名空间。
7. **坐标不可覆盖**:换群产生的新 `target_chat_id / target_message_id / message_thread_id` 作为新坐标记录;不得覆盖旧消息的 Telegram 源/目标坐标。
8. **状态单向推进**:建议迁移主状态为 `preparing → broadcasting → cutover → observing → completed`;失败停在当前阶段并可续跑,回滚显式进入 `rolled_back`,禁止靠删除记录伪装未发生。
9. **持久化先于副作用**:广播、切换意图和重试状态先写 D1 再调用 Telegram;不得用 `waitUntil` 承担迁移关键写入,规则与 [08](08-reliability.md) 一致。
10. **审计不带敏感值**:审计可记录 migration id、旧/新 bot id、旧/新 chat id、计数与状态,但不得记录 Bot Token、Webhook Secret、`migration_token` 原文或广播正文。

## `migration_token`:作用、安全校验与可选性

`migration_token` 用于把「旧 Bot 发出的迁移邀请」关联到某次迁移和某个预期用户,典型载体是新 Bot deep link:

```text
https://t.me/<new_bot_username>?start=<migration_token>
```

它的定位必须明确:

- **不是身份凭证**:持有 token 不代表就是该用户,不能替代 Telegram Webhook Secret、管理员鉴权或用户身份校验;
- **身份事实源始终是 Telegram `message.from.id`**:新 Bot 收到 `/start <migration_token>` 后,必须先通过 Webhook Secret 校验,再验证 token 记录中的预期 `telegram_user_id` 与 `message.from.id` 完全一致;
- **不匹配时不消费**:返回通用迁移失败提示并写安全审计;不得泄露 token 对应的用户、旧 Bot、群或迁移详情;
- **随机、一次性、可过期**:使用密码学安全随机源生成至少 128 bit 熵的 URL-safe opaque 值,只允许消费一次,并设置明确 `expires_at`;
- **不含敏感明文**:token 不编码 user id、Bot Token、Webhook Secret、群 ID、邮箱、用户名或其他业务字段,也不是可解码 JWT;
- **存储最小化**:校验表只存 token 哈希、migration id、预期 user id、过期时间与消费时间;广播 outbox 如需暂存原始 opaque token,应在发送完成或过期后清除,日志与错误上报始终脱敏;
- **消费原子性**:校验未过期、未消费、`message.from.id` 匹配与写入 `consumed_at` 必须在同一事务/条件更新中完成,防止链接重放。

`migration_token` 是**可选的关联提示**,不是迁移成立的唯一途径:

- 有 token:精确关联迁移批次,可统计广播→点击→完成转化,并在多次迁移并存时消除歧义;
- 无 token:若系统能用已验证的 `message.from.id` 在当前租户内唯一匹配旧 customer,可直接迁移/复用该身份;
- 无 token 且匹配不唯一:不得猜测绑定,应提示用户使用最新迁移链接或由管理员人工处理;
- 即使有 token,也必须执行 `message.from.id` 校验,绝不允许「知道链接的人」顶替目标用户。

## 迁移方案选择

### 方案 A:硬切换

先广播,到切换时间立即停用旧 Bot 的业务入口并启用新 Bot;旧 Bot 不再响应。实现简单,但未及时看到广播的用户容易留在旧入口,仅适合用户数很少、可人工逐一确认的部署。

### 方案 B:广播 + `legacy_redirect`(推荐)

1. 切换前由旧 Bot 通过持久化 outbox 向可触达用户发送个性化迁移链接;
2. 切换时新 Bot 成为唯一业务 active,旧 Bot 改为 `legacy_redirect`;
3. `legacy_redirect` 期间,用户若继续给旧 Bot 发消息,旧 Bot**不进入正式 pipeline**,只返回新 Bot deep link 与迁移说明;
4. 默认保留 **72 小时**,并允许按部署配置缩短或延长;配置应表达为 TTL/截止时间,不能无限期默认开启;
5. 到期前查看未触达、未迁移、outbox 失败和旧 Bot 迟到访问量;需要时显式延长并写审计;
6. 到期后解绑旧 Webhook、撤销旧 Token 或将旧 Bot 完全 disabled,但仍保留迁移审计与 D1 历史。

72 小时是默认运营窗口,不是 Telegram 平台保证。旧 Token 若已被 BotFather 撤销、旧 Bot 已删除或旧 Webhook 已解绑,`legacy_redirect` 无法工作,只能依赖已发送广播、人工通知或其他可信渠道。

## 场景一:Bot 换、群不变

```text
[准备]
创建新 Bot → 加入原支持群并授予同等权限 → 配置独立 Webhook/Secret
    │
    ▼
为迁移建立 generation → 为用户生成可选 migration_token → 写广播 outbox
    │
    ▼
[广播]
旧 Bot 分批发送新 Bot deep link → 失败按 outbox 重试,不阻断已成功用户
    │
    ▼
[切换]
新 Bot 置为唯一业务 active → 旧 Bot 置为 legacy_redirect
    │
    ▼
用户 /start <token> 新 Bot
    │
    ├── Webhook Secret 失败 → 401,结束
    ├── token 过期/已消费/用户不匹配 → 不绑定,通用提示 + 审计
    └── 校验通过或 from.id 唯一匹配 → 关联原 customer,继续使用原群 Topic
    │
    ▼
[观察]
默认 72h 收集迁移率/迟到访问/发送失败 → 验证新 Bot 双向中继与权限
    │
    ├── 异常且旧 Token 可用 → 回切旧 Bot active
    └── 稳定 → 结束 redirect、解绑旧 Webhook、清理旧 Token
```

切换后原 Topic 可复用,因为群未变;但所有管理员出站消息只允许 active Bot 处理,旧 Bot 即使仍在群中也必须忽略群消息,否则会双发给用户。

## 场景二:Bot 不变、群换

```text
[准备]
创建新私有 Forum 群 → 开启 Topics → 加入同一个 Bot → 校验管理员权限
    │
    ▼
读取 active conversations → 在新群预建 Topic 或登记为按需创建
    │                              │
    │                              └── 每条新映射保留旧群/旧 thread 坐标
    ▼
验证新群测试 Topic:用户入站、管理员出站、命令、媒体 copy
    │
    ▼
[切换]
短暂设置路由栅栏 → 原子更新 active support route generation → 解除栅栏
    │
    ├── 新 Update → 只路由新群 Topic
    └── 旧群管理员消息 → 只读/静默忽略,不得再发给用户
    │
    ▼
[观察]
保留旧群、旧 Topic 与 Bot 权限 → 核对未知 thread、失败行与审计
    │
    ├── 异常 → active route 切回旧群
    └── 稳定 → 旧群归档为只读,按保留策略移除 Bot
```

预建与按需创建可二选一:

- **预建**:切换前为所有 active conversation 建新 Topic,切换更平滑,但大规模迁移会受 Telegram 限流影响;
- **按需创建**:首次新消息到达时创建,前置成本低,但首条消息延迟更高,并继续受 [02](02-forum-routing.md) 的 Topic 创建崩溃窗口约束。

无论哪种方式,旧 `message_thread_id` 都不能直接写入新群;Topic ID 只在其所属 `chat_id` 内有意义。

## 场景三:Bot 和群都换

推荐拆成两个可独立验收的迁移,中间必须有稳定观察期:

```text
[阶段 1:先换群]
旧 Bot + 旧群
    │
    ▼
按「场景二」迁到新群
    │
    ▼
旧 Bot + 新群稳定运行
    │   验证 Topic 映射、命令、媒体、管理员回复、回滚路径
    ▼
[阶段 2:再换 Bot]
按「场景一」在新群加入新 Bot
    │
    ▼
广播 + 新 Bot active + 旧 Bot legacy_redirect(默认 72h)
    │
    ▼
新 Bot + 新群稳定运行
    │
    ├── Bot 阶段异常 → 只回滚 Bot,群仍保持新群
    └── 稳定 → 结束 redirect,再清理旧群/旧 Bot
```

禁止在同一个不可观察步骤中同时改 active bot、active support chat 与全部 Topic 映射。若业务被迫一次切换,也必须在状态机中保留两个独立 generation 和两个回滚点,不能把它们压成一个布尔开关。

## 广播 outbox

迁移广播属于外部副作用,必须使用持久化 outbox,不得在一个管理请求中循环调用 Telegram,也不得依赖 Worker 内存或 `waitUntil`。优先复用 [06](06-data-model.md) 已规划的通用 `outbox`,通过 action/payload 区分迁移广播,不要再造第二套重试引擎。

每个接收者一条 outbox 记录,核心约束:

- 幂等键建议为 `migration:<migration_id>:broadcast:<telegram_user_id>`;重复启动迁移不会重复插入同一广播;
- 发送者必须是**旧 Bot**,因为只有旧 Bot 已与旧用户建立私聊关系;
- payload 只包含渲染所需最小字段与 URL-safe opaque token;不放 Bot Token、Webhook Secret 或用户消息正文;
- 状态沿用通用 outbox 的 `pending / sent / failed`,并记录 attempts、`last_error`、`sent_at`;失败原因分为可重试与永久失败;
- 429 按 `retry_after` 延迟,网络/5xx 退避重试,403(用户拉黑旧 Bot)记永久失败并计入未触达,不无限重试;
- 按 Bot API 限流分批发送,支持暂停、恢复和从游标续跑;Worker 重启不能丢进度;
- 切换门槛由运营策略决定,但不得把「100% 广播成功」作为硬前提——已拉黑旧 Bot 的用户永远可能失败;应展示 sent/failed/pending/已迁移计数;
- 广播文案至少包含:旧入口停止时间、新 Bot 用户名/链接、用户需主动 `/start`、旧 Bot redirect 截止时间、无法迁移时的人工联系渠道;
- token 原文发送后不写日志;过期或迁移完成后清理 outbox 中不再需要的个性化 payload。

## 失败恢复与回滚

| 失败点 | 恢复方式 | 回滚边界 |
|--------|----------|----------|
| 新 Bot `getMe`、Webhook 或群权限预检失败 | 保持旧 Bot active,修复配置后重跑 preparing | 尚未切换,无需业务回滚 |
| 新群 Topic 只创建一部分 | 依据每条映射状态幂等续跑;已建 Topic 不重复创建 | active route 未切换前继续使用旧群 |
| 广播部分失败 | outbox 从 pending/可重试失败继续;403 记未触达 | 广播本身无需撤回;切换时间可按策略延后 |
| `migration_token` 过期或已消费 | 用已验证 `from.id` 唯一匹配,或签发新 token | 不得复活旧 token 或跳过身份校验 |
| 切换后新 Bot 异常 | 停止新 generation,旧 Bot 从 redirect 恢复 active | 仅在旧 Token/Webhook/权限仍保留时可完整回切 |
| 切换后新群异常 | active route 指回旧群,新群路由转只读 | 旧群和旧 Topic 未删除时可回切;新群已产生的消息不删除 |
| Worker 在切换中崩溃 | 读取持久化 migration state 与 generation 继续;所有步骤幂等 | 不依据内存猜测当前阶段 |
| 旧 Token 已撤销或旧群已删除 | 采用 forward-fix:修复新端,不能承诺完整回滚 | 这是不可逆点,必须发生在观察期和验收之后 |

回滚同样是一次显式状态变更,必须写审计。回滚不删除已经发送的广播、不篡改已产生的消息记录,也不把 token 标回未消费;重新发起迁移时创建新的 migration id、generation 和 token。

清理顺序必须是:

```text
验收通过 → 观察期结束 → 停止 legacy_redirect → 解绑旧 Webhook
         → 撤销/删除旧 Token → 移除旧群权限 → 按保留策略归档旧群
```

任何提前清理都会缩小恢复面。其中换群但不换 Bot 时,「撤销旧 Token」不适用;换 Bot 但不换群时,「归档旧群」不适用。

## 消息与媒体边界

### 文本、状态与消息索引

- D1 中 customer 状态、conversation 逻辑身份、messages、inbox 与 audit 应连续保留;
- 换 Bot 时 Telegram `user_id` 通常不变,但仍以新 Bot Webhook 中经过校验的 `message.from.id` 为准,不能相信 deep link 参数自报身份;
- 换群时为 conversation 增加新路由坐标,旧群坐标保留用于历史查询与回滚;
- Telegram 私聊历史不会出现在新 Bot 窗口;群历史不会自动出现在新群 Topic。需要复制时应另做可中断、可限速、可审计的回填任务,不得阻塞正式切换;
- 切换栅栏前到达的旧 generation Update 按旧规则收尾;栅栏后的新 Update 只走新 active 路由,避免同一消息同时进入两个群或由两个 Bot 回复。

### 媒体

| 迁移 | `media_file_id` | 群内消息坐标 `copyMessage` | 处理建议 |
|------|-----------------|----------------------------|----------|
| Bot 换、群不变 | **失效**:Bot 级句柄不可跨 Bot 复用 | 新 Bot 在原群有权限且未开启 protected content 时可用 | 保留新 Bot 对原群的访问权,以 `(chat_id, message_id)` 重放;重要附件可依赖可选 R2 归档 |
| Bot 不变、群换 | **仍可用**:Bot 未变 | Bot 同时能访问旧群和新群时可用 | 观察期内不要移除旧群权限;按需复制,无需为切换复制全部历史 |
| Bot 和群都换 | 按换 Bot 规则失效 | 新 Bot 必须仍能访问旧群才可从旧坐标复制 | 先换群可让旧 Bot 完成必要复制;换 Bot 后保留旧群访问或使用 R2 独立归档 |

`messages.media_file_id`、`source_*`、`target_*` 各自表达不同恢复路径,不得因为某一路径失效就覆盖或删除其他坐标。完整三级存储边界见 [07](07-storage.md)。

## 验收条件

### 通用

- [ ] 任一时刻每个部署最多一个业务 active Bot、最多一个 `legacy_redirect` Bot、最多一个业务 active 支持群;全部 active conversation 均指向该群且各自最多一个 active Topic 路由,旧端不会双收双发;
- [ ] 迁移状态、generation、outbox、token 消费与 active 指针均持久化,Worker 重启后可续跑;
- [ ] 所有准备步骤可安全重试;重复执行不会重复建映射、重复消费 token 或无界重复广播;
- [ ] `migration_token` 为随机、一次性、可过期、URL-safe opaque 值,不含敏感明文;存储以哈希为主;
- [ ] token 验证始终同时校验 Telegram `message.from.id`;token 不匹配时不消费、不绑定、不泄露目标用户信息;
- [ ] 无 token 时仅允许按已验证 `from.id` 做唯一匹配;歧义场景拒绝自动绑定;
- [ ] 广播通过通用 outbox 持久化,支持限流、退避、暂停、恢复、幂等与 sent/failed/pending 统计;
- [ ] 方案 B 的 `legacy_redirect` 默认 72 小时且可配置,只做迁移提示,不进入正式消息 pipeline;
- [ ] 切换、延期、回滚、完成与清理均有审计,且日志不含 Token、Secret、token 原文或消息正文;
- [ ] 观察期内源 Bot/源群保留,验收后才进入不可逆清理;不可回滚点在执行前有明确告警。

### Bot 换、群不变

- [ ] 新 Bot 加入原群并具备与旧 Bot 等价的 Topic/消息权限;
- [ ] 用户从个性化链接或无 token `/start` 进入时,可关联原 customer 并继续使用原 Topic;
- [ ] 旧 Bot 在 redirect 期收到用户消息只返回迁移提示,管理员群消息只由新 Bot 处理;
- [ ] 已验证旧 `file_id` 不被新 Bot 直接使用,媒体可在权限满足时按原群消息坐标重放;
- [ ] 旧 Token 保留时可回切;撤销旧 Token 后系统明确进入 forward-fix 模式。

### Bot 不变、群换

- [ ] 新群是私有 Forum,Topics、Bot 管理员权限与 protected content 配置通过预检;
- [ ] 每个 active conversation 已有新 Topic 或可幂等按需创建,旧/new `(chat_id, thread_id)` 坐标并存且不覆盖;
- [ ] 切换后用户私聊入口不变,新消息只进入新群,旧群管理员消息不再发给用户;
- [ ] 观察期内可把 active route 切回旧群,且新群已产生的消息与审计被保留。

### Bot 和群都换

- [ ] 迁移按「先群后 Bot」分成两个 generation、两个验收门和两个回滚点;
- [ ] 群迁移稳定后才启动 Bot 广播和 token 发放;
- [ ] Bot 阶段回滚不会把群路由一起退回,两条迁移轴可以独立恢复;
- [ ] 最终清理前已核对未迁移用户、广播失败、旧入口访问量、inbox/outbox 积压和媒体可恢复路径。
