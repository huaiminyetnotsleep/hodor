# 06 · D1 数据模型

> **hodor 设计文档 · 06/12**
> 上一篇:[05-webhook-management](05-webhook-management.md) · 下一篇:[07-storage](07-storage.md) · [返回总览](README.md)

---

## 全局约定

- **时间戳**:统一 ISO 8601 UTC 文本(`TEXT`),如 `2026-09-24T10:15:30Z`;
- **Telegram ID**(`user_id` / `chat_id` / `message_id` / `update_id` / `thread_id`):`INTEGER`(SQLite 64 位整数,容量充足);
- **JSON**:`TEXT` 存 JSON 字符串;
- **布尔**:`INTEGER` 0/1;
- 主键 `id`:自增 `INTEGER PRIMARY KEY`;
- **outbox 表属 Phase 2**,Phase 1 迁移不创建(经 Expand/Contract 加入,见 [08](08-reliability.md)),本文一并给出定义以免未来返工。

## 实体关系总览

```text
bots 1─────* support_admins
  │
  ├─1─────* customers 1─────1 conversations
  │                                │
  │                                └─1────* messages
  ├─1─────* inbox_updates
  └─1─────* audit_logs
```

## 表结构

### bots(单 Bot Phase 1 只有一行,由初始化 seed,见 05)

| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | |
| telegram_bot_id | INTEGER UNIQUE | getMe 获得 |
| webhook_key | TEXT UNIQUE | URL 路径标识(随机) |
| encrypted_bot_token | TEXT **NULLABLE** | Phase 1 恒为 NULL(Token 在 env,见 05) |
| webhook_secret_hash | TEXT | SHA-256(secret),鉴权与登记用 |
| support_chat_id | INTEGER | 私有支持群 |
| status | TEXT | `active` / `disabled` |
| config_version | INTEGER | 配置代数,绑定/解绑递增 |
| created_at / updated_at | TEXT | |

### customers(用户,封禁唯一事实源)

| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | Topic 标题中的 `#序号` |
| bot_id | INTEGER FK → bots | |
| telegram_user_id | INTEGER | |
| display_name / username | TEXT | 标题渲染与刷新用(见 02) |
| **blocked** | INTEGER | **封禁唯一事实源**(见 04) |
| **bot_blocked_by_user** | INTEGER | **H3:用户已拉黑/删除 Bot**,出站 403 时置位(见 03) |
| created_at / updated_at | TEXT | |

`UNIQUE(bot_id, telegram_user_id)`

### conversations(每用户至多一个 active)

| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | conversation_id |
| bot_id / customer_id | INTEGER FK | |
| support_chat_id | INTEGER | 冗余存储,便于反向查询 |
| message_thread_id | INTEGER | Topic ID;`creating` 期间为 NULL |
| **status** | TEXT | `creating / open / closed / archived`(生命周期,**不含 blocked**,见 04) |
| canonical_title | TEXT | 当前渲染标题(见 02) |
| last_message_at | TEXT | 排序用 |
| created_at / updated_at | TEXT | |

`UNIQUE(bot_id, support_chat_id, message_thread_id)` ← 反向映射(管理员回复路由)

### support_admins(H 级修订:新增,管理员白名单)

| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | |
| bot_id | INTEGER FK → bots | |
| telegram_user_id | INTEGER | |
| display_name | TEXT | 展示用 |
| created_at | TEXT | |

`UNIQUE(bot_id, telegram_user_id)`

### inbox_updates(幂等核心,见 03)

| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | |
| bot_id | INTEGER FK | |
| telegram_update_id | INTEGER | |
| payload_json | TEXT | 原始 Update(Phase 3 起大对象可外移 R2) |
| **status** | TEXT | `pending / processed / failed` |
| attempts | INTEGER | 处理尝试次数,上限 `MAX_ATTEMPTS=8` |
| received_at / processed_at | TEXT | |
| last_error | TEXT | 最近失败原因(不含敏感值) |

`UNIQUE(bot_id, telegram_update_id)`

### messages(中继记录)

| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | |
| conversation_id | INTEGER FK | |
| direction | TEXT | `inbound`(用户→Topic)/ `outbound`(管理员→用户) |
| source_chat_id / source_message_id | INTEGER | 复制源 |
| target_chat_id / target_message_id | INTEGER | 复制目标 |
| message_thread_id | INTEGER | 冗余 Topic ID |
| content_type | TEXT | text / photo / voice / document / … |
| text_content | TEXT | 文本或 caption,检索用 |
| media_file_id | TEXT | Telegram file_id |
| r2_object_key | TEXT NULLABLE | Phase 3 起附件归档键(见 07) |
| created_at | TEXT | |

### audit_logs(H 级修订:新增,支撑 05/04/09 的审计要求)

| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | |
| bot_id | INTEGER FK | |
| actor_type | TEXT | `admin` / `system` |
| actor_id | INTEGER | admin 的 telegram_user_id;system 为 NULL |
| action | TEXT | `ban` / `unban` / `webhook_bind` / `webhook_unbind` / `admin_add` / `admin_remove` / `topic_creation_retry` … |
| detail_json | TEXT | 上下文(customer_id、thread_id 等;**不含 Token/Secret/消息正文**) |
| created_at | TEXT | |

### outbox(Phase 2 预定,Phase 1 不建表)

| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | |
| idempotency_key | TEXT UNIQUE | 发送幂等键 |
| bot_id | INTEGER FK | |
| telegram_method | TEXT | |
| payload_json | TEXT | |
| status | TEXT | `pending / sent / failed` |
| attempts / sent_at / last_error / created_at | | |

## 索引清单(M 级修订:唯一索引之外的主查询索引)

```sql
-- 唯一索引(建表约束)
UNIQUE bots(telegram_bot_id)
UNIQUE bots(webhook_key)
UNIQUE customers(bot_id, telegram_user_id)
UNIQUE conversations(bot_id, support_chat_id, message_thread_id)
UNIQUE support_admins(bot_id, telegram_user_id)
UNIQUE inbox_updates(bot_id, telegram_update_id)
UNIQUE outbox(idempotency_key)                        -- Phase 2

-- 次要索引(高频查询路径)
CREATE INDEX idx_conversations_customer   ON conversations(bot_id, customer_id);
CREATE INDEX idx_conversations_status     ON conversations(bot_id, status);
CREATE INDEX idx_messages_conversation    ON messages(conversation_id, created_at);
CREATE INDEX idx_inbox_status             ON inbox_updates(status, attempts);   -- DLQ 巡检
CREATE INDEX idx_audit_bot_time           ON audit_logs(bot_id, created_at);
```

## 状态值字典(全项目统一,禁止各处自造)

| 字段 | 合法值 | 语义 |
|------|--------|------|
| `inbox_updates.status` | `pending / processed / failed` | 见 03 状态机 |
| `conversations.status` | `creating / open / closed / archived` | Topic 生命周期,见 02/04 |
| `bots.status` | `active / disabled` | |
| `messages.direction` | `inbound / outbound` | |
| `customers.blocked` | 0 / 1 | 封禁唯一事实源,见 04 |
| `customers.bot_blocked_by_user` | 0 / 1 | H3 标志,见 03 |

迁移文件组织与兼容规则(Expand/Contract)见 [08](08-reliability.md)。

---

下一篇:[07-storage — 存储策略与平台限制](07-storage.md)
