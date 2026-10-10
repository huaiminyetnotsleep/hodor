# 管理命令路由与 General Topic

> 2026-10-10 验证命令拆分任务确立。约束 `src/pipeline/classify.ts` 的客服群分类、
> `src/routes/webhook.ts` 的线程归一化与 `src/pipeline/commands.ts` 的执行门。

---

## 场景：新增/调整客服群管理命令（尤其涉及 General）

### 1. Scope / Trigger

- 新增管理命令、调整命令可用范围、或触碰 General 分类的放行集合时适用。

### 2. Signatures

- `classifyUpdate(update, supportChatId)`：客服群消息 → `outbound`（带合法
  `message_thread_id`）/ `topic_event` / `broadcast` / `ignore`。
- `isGeneralGlobalCommand(text)`（src/copy.ts）：General 放行集合判定——
  Set 全名匹配（防 `/verifymodeX` 前缀巧合）、容忍 `@bot` 后缀。
- `GENERAL_THREAD_ID = 1`（src/pipeline/classify.ts 导出常量）。

### 3. 契约

- **General 发言没有 `message_thread_id` 字段**（Telegram 平台行为）：classify 对
  客服群无 thread 字段且 `message_id` 合法的消息，仅放行广播命令与全局命令集合
  （`/verifyon` `/verifyoff` `/verifymode` `/verifymode_math` `/verifymode_button`
  `/verifymode_turnstile` `/help`）为 outbound；webhook 派发处把**确无字段**的
  outbound 归一化为 thread 1。字段存在但非法（0/字符串）仍按畸形 ignore。
- **向 General 发消息必须省略 `message_thread_id`**（2026-10-10 生产实测）：
  论坛群显式传 `message_thread_id=1` 会 400「message thread not found」，省略才落
  General——广播与归档回复的既有做法；`replyInTopic` 对 threadId=1 一律省略该字段。
  归一化只用于路由判定，不透传到 sendMessage。
- **命令菜单是聊天级作用域**：`BotCommandScope` 无 Topic 维度，`setMyCommands`
  无法按 Topic 隐藏命令——「仅 General 生效」靠 `handleCommand` 内运行时执行门
  （`threadId === GENERAL_THREAD_ID`，非门内只回引导提示、零副作用）实现，
  不靠菜单。新增全局命令照常登记 `ADMIN_COMMAND_MENU`（全群可见）。
- 需要绑定的命令（/ban /note /risk 等）不放行进 General——General 无绑定语义、
  不参与中继，维持 ignore。
- 新全局命令加入放行集合时：classify 集合、copy 判定、门位集合、测试四处同改；
  文档注明「仅在 General 生效」。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| General 执行全局命令 | 执行并回复 thread 1 |
| 其他 Topic 执行验证配置命令 | 引导提示，settings/pending/账本零变更 |
| General 非命令 / 非放行命令 / 非法 thread | ignore（现状语义） |
| `/broadcast` 判定 | 先于全局命令集合，语义不变 |

### 5. Tests Required

- classify：放行集合逐命令、@形态、前缀巧合、非法 thread、broadcast 回归。
- 命令：门拦截零副作用断言（settings/pending/账本）、General 归一化 + 显式
  thread 1 双路径、别名回归。
- webhook 端到端：回复 thread 落点、非管理员拒绝。

### 6. Wrong vs Correct

#### Wrong

```ts
// 靠菜单作用域实现「仅 General 可用」——平台不支持 Topic 级 scope
await setMyCommands({ scope: { type: "chat_forum_topic", ... } }); // 不存在
```

#### Correct

```ts
// classify 放行 + 归一化 thread 1 + handleCommand 运行时执行门
if (threadId !== GENERAL_THREAD_ID) return replyInTopic(..., GENERAL_ONLY_NOTICE);
```

---

## 相关规范

- [全用户广播](./broadcast.md) — `/broadcast` 的 General 先例（本规范沿用其分类路径）
- [错误处理](./error-handling.md) — 命令回复的 retryable/permanent 消费约定
