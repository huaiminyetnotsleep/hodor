/**
 * domain · 用户侧/服务侧文案常量（S4，docs/03「用户侧文案模板」）。
 * Phase 1 集中为常量 + 渲染函数，后续可移入 KV（docs/03）；占位符单点定义：
 * {customer_no} → `#<customers.id>`；{timestamp} → ISO 8601 UTC。
 * WATCH_NOTICE / BANNED_NOTICE 等由后续任务在此追加。
 */

/** 新客户首条消息的欢迎语（docs/03：简短说明用途与响应预期；含 #序号） */
export const WELCOME_TEMPLATE =
  '👋 你好，欢迎联系支持团队！\n\n' +
  '你的会话编号是 {customer_no}，这条消息与之后发送的内容都会转达给客服。\n' +
  '直接发送你想咨询的文字或图片即可，客服看到后会尽快回复。';

export function renderWelcome(customerId: number): string {
  return WELCOME_TEMPLATE.replaceAll('{customer_no}', `#${customerId}`);
}

/**
 * 崩溃窗口预案的标记消息（docs/02）：creating 残留重试创建成功后发进新 Topic，
 * 内容含 #序号与时间戳，便于运维检索与人工合并重复 Topic。
 */
export const CRASH_MARKER_TEMPLATE =
  'ℹ️ 系统标记：本 Topic 在创建中断后重试生成，归属客户 {customer_no}，时间 {timestamp}。';

export function renderCrashMarker(customerId: number, timestampIso: string): string {
  return CRASH_MARKER_TEMPLATE.replaceAll('{customer_no}', `#${customerId}`).replaceAll('{timestamp}', timestampIso);
}

/** 403 一次性提示（docs/03「用户拉黑 Bot 的 403 处理」）：bot_blocked_by_user 0→1 跳变时发进 Topic */
export const BOT_BLOCKED_NOTICE = '⚠️ 用户已停止与 Bot 的对话，回复暂时无法送达';

/** 恢复提示（docs/03）：用户回归、入站链路复位 bot_blocked_by_user 时发进 Topic（S5 联调） */
export const BOT_UNBLOCKED_NOTICE = '✅ 用户已恢复对话';

/**
 * 高危入站提示（S7，docs/03 文案模板 / docs/04「24h 限频」）：watchlisted 用户入站
 * 中继后发进 Topic——告知管理员该账号处于重点关注名单、其消息仍正常中继处理；
 * 24h 限频由入站链路控制，此处只管文案。
 */
export const WATCH_NOTICE = '⚠️ 该用户在高危名单，消息仍正常中继处理，请多加注意';

/** /risk 置位提示（S7，docs/04 /risk 步骤 3：置位时向本 Topic 发一次性提示） */
export const RISK_SET_NOTICE = '⚠️ 已将该用户列入高危名单：其消息仍正常中继处理，请持续关注';

// ── 危险命令两步确认（S8，docs/04 /purge /deluser；确认无状态，提示即用法说明）──────────

/** /purge 确认提示（docs/04 /purge 步骤 2：含 #序号、10 分钟窗口与 confirm 用法） */
export const PURGE_CONFIRM_PROMPT_TEMPLATE =
  '⚠️ 将清除 {customer_no} 的全部会话数据（含图片/视频/文件引用），不可逆。\n' +
  '10 分钟内发送 /purge confirm {customer_no} 执行。';

/** /deluser 确认提示（docs/04 /deluser：两步确认与 /purge 相同） */
export const DELUSER_CONFIRM_PROMPT_TEMPLATE =
  '⚠️ 将删除 {customer_no} 的全部数据与身份（会话、消息与 Topic），不可逆。\n' +
  '10 分钟内发送 /deluser confirm {customer_no} 执行。';

/** confirm 序号不匹配拒绝（docs/04 步骤 3：发错 Topic/写错号一律拒绝并提示作废） */
export const CONFIRM_MISMATCH_NOTICE = '❌ 序号不匹配，操作已作废。请核对本 Topic 用户的 #序号 后重新发起。';

/** confirm 超时拒绝（docs/04 步骤 3：超出 10 分钟窗口拒绝并提示作废） */
export const CONFIRM_EXPIRED_NOTICE = '❌ 确认已超时（10 分钟窗口），操作已作废，请重新发起。';

/** /purge 完成公告（docs/04 步骤 4⑤：Topic 已删，公告与审计是仅存的痕迹；发进 General Topic） */
export const PURGE_DONE_ANNOUNCEMENT_TEMPLATE = '🧹 已清除 {customer_no} 的全部会话数据，对应 Topic 已删除。';

/** /deluser 完成公告（docs/04 步骤 7：同上；提示复活路径） */
export const DELUSER_DONE_ANNOUNCEMENT_TEMPLATE =
  '🗑️ 已删除 {customer_no} 的全部数据与身份；该用户需重新 /start 才能开启新对话。';

export function renderPurgeConfirmPrompt(customerId: number): string {
  return PURGE_CONFIRM_PROMPT_TEMPLATE.replaceAll('{customer_no}', `#${customerId}`);
}

export function renderDeluserConfirmPrompt(customerId: number): string {
  return DELUSER_CONFIRM_PROMPT_TEMPLATE.replaceAll('{customer_no}', `#${customerId}`);
}

export function renderPurgeDoneAnnouncement(customerId: number): string {
  return PURGE_DONE_ANNOUNCEMENT_TEMPLATE.replaceAll('{customer_no}', `#${customerId}`);
}

export function renderDeluserDoneAnnouncement(customerId: number): string {
  return DELUSER_DONE_ANNOUNCEMENT_TEMPLATE.replaceAll('{customer_no}', `#${customerId}`);
}
