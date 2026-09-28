/**
 * store · conversations 表访问（S4，docs/06；docs/02「每用户至多一个 open」）。
 * 列清单唯一来源 = migrations/0001_init.sql；行结构在此声明一次，消费方经 `../store` 引用。
 *
 * Topic 创建编排（createForumTopic 调用、崩溃窗口标记消息与审计）在
 * src/pipeline/inbound/handler.ts——本模块只提供查/建/推进三个状态原语，不做 IO 编排。
 */

export type ConversationStatus = 'creating' | 'open' | 'closed' | 'archived';

export interface Conversation {
  id: number;
  bot_id: number;
  customer_id: number;
  /** 冗余存储，便于反向查询（docs/06） */
  support_chat_id: number;
  /** Topic ID；creating 期间为 NULL（docs/02 崩溃窗口） */
  message_thread_id: number | null;
  status: ConversationStatus;
  /** 当前渲染标题（docs/02；attachTopic / updateTitle 时写入） */
  canonical_title: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

/** open 会话的 thread 恒非空（查询 WHERE 已保证，类型在此收窄一次供消费方直接使用） */
export type OpenConversation = Conversation & { message_thread_id: number };

const SELECT_COLUMNS =
  'id, bot_id, customer_id, support_chat_id, message_thread_id, status, canonical_title, last_message_at, created_at, updated_at';

function nowIso(): string {
  return new Date().toISOString(); // 全局约定：ISO 8601 UTC（migrations/0001 头注）
}

/** 该客户当前 open 会话（至多一个，docs/02）；含 thread IS NOT NULL 守卫 */
export async function findOpenByCustomer(
  db: D1Database,
  botId: number,
  customerId: number,
): Promise<OpenConversation | undefined> {
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM conversations WHERE bot_id = ? AND customer_id = ? AND status = 'open' AND message_thread_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .bind(botId, customerId)
    .first<Conversation>();
  if (row === null) return undefined;
  return row as OpenConversation; // WHERE 子句保证 message_thread_id 非空
}

/**
 * 出站反查行（S5，docs/02「反向映射：管理员回复路由」）：open 会话 + 客户投递所需字段一次取回。
 * 投递目标 telegram_user_id 以 D1 事实源为准（不得用消息上下文推断用户）；
 * bot_blocked_by_user 随行取回，供 403 处理判定 0→1 跳变（一次性提示，docs/03）。
 * S6 扩展 display_name / watchlisted：命令管线标题重渲染所需（docs/02 标题 = 档案 + 标志纯派生）。
 */
export interface OpenConversationWithCustomer extends OpenConversation {
  /** JOIN customers.telegram_user_id —— copyMessage 的 to 坐标唯一事实源 */
  customer_telegram_user_id: number;
  /** JOIN customers.bot_blocked_by_user —— 403 置位是否为首次（0→1 才提示） */
  customer_bot_blocked_by_user: number;
  /** JOIN customers.display_name —— 标题渲染（可空，调用方回退 telegram_user_id，docs/03 判空） */
  customer_display_name: string | null;
  /** JOIN customers.watchlisted —— 标题图标第二优先级（docs/02） */
  customer_watchlisted: number;
}

/** 按 (bot_id, support_chat_id, message_thread_id) 反查 open 会话（含客户信息）；查无返回 undefined */
export async function findOpenWithCustomerByThread(
  db: D1Database,
  botId: number,
  supportChatId: number,
  messageThreadId: number,
): Promise<OpenConversationWithCustomer | undefined> {
  const row = await db
    .prepare(
      `SELECT c.id, c.bot_id, c.customer_id, c.support_chat_id, c.message_thread_id, c.status,
              c.canonical_title, c.last_message_at, c.created_at, c.updated_at,
              cu.telegram_user_id AS customer_telegram_user_id,
              cu.bot_blocked_by_user AS customer_bot_blocked_by_user,
              cu.display_name AS customer_display_name,
              cu.watchlisted AS customer_watchlisted
       FROM conversations c
       JOIN customers cu ON cu.id = c.customer_id
       WHERE c.bot_id = ? AND c.support_chat_id = ? AND c.message_thread_id = ? AND c.status = 'open'
       ORDER BY c.id DESC LIMIT 1`,
    )
    .bind(botId, supportChatId, messageThreadId)
    .first<OpenConversationWithCustomer>();
  return row ?? undefined;
}

/**
 * 命令管线目标反查行（S6 /unban，docs/04「/unban 步骤 4」需命中曾 close 的 Topic）：
 * open 或 closed 会话 + 标题渲染所需客户字段；creating 行 thread 为 NULL 不会命中，
 * archived 无对应流程不参与（docs/02：如未来提供归档能力，另行决策）。
 */
export interface CommandTargetWithCustomer extends Conversation {
  customer_telegram_user_id: number;
  /** JOIN customers.blocked —— S7 /risk /unrisk 重渲染标题需当前封禁态（🔇 优先级，docs/02） */
  customer_blocked: number;
  customer_display_name: string | null;
  customer_watchlisted: number;
}

/** 按 thread 反查 open|closed 会话（含客户信息）；查无返回 undefined（命令静默，docs/04） */
export async function findCommandTargetByThread(
  db: D1Database,
  botId: number,
  supportChatId: number,
  messageThreadId: number,
): Promise<CommandTargetWithCustomer | undefined> {
  const row = await db
    .prepare(
      `SELECT c.id, c.bot_id, c.customer_id, c.support_chat_id, c.message_thread_id, c.status,
              c.canonical_title, c.last_message_at, c.created_at, c.updated_at,
              cu.telegram_user_id AS customer_telegram_user_id,
              cu.blocked AS customer_blocked,
              cu.display_name AS customer_display_name,
              cu.watchlisted AS customer_watchlisted
       FROM conversations c
       JOIN customers cu ON cu.id = c.customer_id
       WHERE c.bot_id = ? AND c.support_chat_id = ? AND c.message_thread_id = ? AND c.status IN ('open', 'closed')
       ORDER BY c.id DESC LIMIT 1`,
    )
    .bind(botId, supportChatId, messageThreadId)
    .first<CommandTargetWithCustomer>();
  return row ?? undefined;
}

/**
 * creating 残留检测（docs/02 崩溃窗口预案入口）：上次 createForumTopic 成功但写回前崩溃时，
 * 该行停留在 status='creating' 且 thread 为 NULL；重试路径据此发标记消息 + 审计。
 */
export async function findCreatingByCustomer(
  db: D1Database,
  botId: number,
  customerId: number,
): Promise<Conversation | undefined> {
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM conversations WHERE bot_id = ? AND customer_id = ? AND status = 'creating' ORDER BY id DESC LIMIT 1`,
    )
    .bind(botId, customerId)
    .first<Conversation>();
  return row ?? undefined;
}

export interface CreateConversationInput {
  botId: number;
  customerId: number;
  supportChatId: number;
}

/** 意图先落库（docs/02 步骤 1）：status='creating'、thread NULL；返回新行 */
export async function createConversation(db: D1Database, input: CreateConversationInput): Promise<Conversation> {
  const now = nowIso();
  const insert = await db
    .prepare(
      "INSERT INTO conversations (bot_id, customer_id, support_chat_id, status, created_at, updated_at) VALUES (?, ?, ?, 'creating', ?, ?)",
    )
    .bind(input.botId, input.customerId, input.supportChatId, now, now)
    .run();

  const row = await db.prepare(`SELECT ${SELECT_COLUMNS} FROM conversations WHERE id = ?`).bind(insert.meta.last_row_id).first<Conversation>();
  if (row === null) {
    // 防御：插入后读不到行意味着一致性被破坏，按失败上抛 → inbox 5xx 重投
    throw new Error(`conversations row missing after insert: id=${insert.meta.last_row_id}`);
  }
  return row;
}

/** 创建成功后写回（docs/02 步骤 4）：thread + status='open' + canonical_title 一次落库 */
export async function attachTopic(
  db: D1Database,
  conversationId: number,
  messageThreadId: number,
  canonicalTitle: string,
): Promise<void> {
  await db
    .prepare("UPDATE conversations SET message_thread_id = ?, status = 'open', canonical_title = ?, updated_at = ? WHERE id = ?")
    .bind(messageThreadId, canonicalTitle, nowIso(), conversationId)
    .run();
}

/** 改名刷新（docs/02 刷新时机②）：canonical_title 与 editForumTopic 同步 */
export async function updateTitle(db: D1Database, conversationId: number, canonicalTitle: string): Promise<void> {
  await db
    .prepare('UPDATE conversations SET canonical_title = ?, updated_at = ? WHERE id = ?')
    .bind(canonicalTitle, nowIso(), conversationId)
    .run();
}

/**
 * 按客户删除其全部 conversations 行（S8 /purge /deluser，docs/04 执行步骤 ③/④；返回删除行数）。
 * 必须在该客户全部 messages 行删除之后调用（messages.conversation_id 外键引用，docs/06）；
 * Phase 1 每客户至多一个会话行（docs/02「每用户至多一个 open」，closed/archived 尚无写入路径）。
 */
export async function deleteByCustomer(db: D1Database, customerId: number): Promise<number> {
  const res = await db.prepare('DELETE FROM conversations WHERE customer_id = ?').bind(customerId).run();
  return res.meta.changes ?? 0;
}

/**
 * 会话重开（S6 /unban，docs/04「/unban 步骤 4」）：reopenForumTopic 成功后置回 'open'。
 * 仅在 Telegram 侧重开成功后调用——D1 状态不得领先于 Topic 实际状态（否则出站中继
 * 会向 closed Topic 投递）。永久失败时会话保持 closed，由调用方留日志对账。
 */
export async function reopenConversation(db: D1Database, conversationId: number): Promise<void> {
  await db.prepare("UPDATE conversations SET status = 'open', updated_at = ? WHERE id = ?").bind(nowIso(), conversationId).run();
}
