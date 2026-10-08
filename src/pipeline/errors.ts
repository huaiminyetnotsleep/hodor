/**
 * Telegram 错误摘要谓词（阶段 6）：对 client 已消毒的 errorMessage（含
 * Telegram description，client 契约）做语义识别——不侵入 client 的分类
 * 矩阵（错误语言仍是三态 kind，本模块只做 permanent 内的子类判定）。
 *
 * 判定原则：宁可漏判不可误判——不匹配就走默认 permanent 语义（丢弃 +
 * warn），绝不把可恢复的配置问题（如 bot 被移出群）误判成死绑定。
 */

/**
 * topic 已不存在（被 TG 客户端原生删除）：向已删除 thread 发消息 /
 * 重开已删除 topic 的 Telegram 400 description 形态。
 * 触发绑定自愈（design §五.2）；TOPIC_CLOSED（关闭 ≠ 删除）刻意不匹配。
 */
export function isTopicGoneError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /message thread not found|topic_id_invalid/i.test(errorMessage);
}

/**
 * 消息已不存在（T39 /purgemsg 逐条删除时）：已被手工删除 / 重复执行时
 * Telegram 400 description 形态。归入「已不存在」计数而非失败——不把
 * 未删除内容标为已清空的语义只针对真正的删除失败。
 */
export function isMessageGoneError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /message to delete not found/i.test(errorMessage);
}
