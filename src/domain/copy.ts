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
