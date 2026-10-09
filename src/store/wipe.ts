/**
 * wipe store（T40 /wipealldata）：users / topics / messages 三表清空的唯一入口。
 *
 * 跨表操作单列一个模块（不塞进任何单表 store 的职责）：
 * - **清**：users（全部用户档案与治理态）、topics（全部绑定）、messages（全部账本）、
 *   delete_confirmations（残留二次确认行）、broadcasts（广播任务行——活跃 preparing/pending
 *   先置 cancelled、sending 置 failed；循环会在下一位收件人前停止，已进入 Telegram
 *   的单条请求仍可能送达）；
 * - **留**：settings（验证开关 / 模式——PRD「settings 保留」）、processed_updates
 *   （幂等台账——清了它 Telegram 重推会重放全部历史 update，绝对不可清）、
 *   bots（bot 身份，webhook 绑定依赖）。
 * 三条 DELETE 非原子（D1 无跨语句事务）——已接受权衡：任一条失败抛出 →
 * 重推 / 重复确认重跑幂等收敛到全空。已知边缘：若失败后 Telegram 重推
 * 迟到超过确认键盘 60 秒窗口，确认回调会走超时分支拒绝重执行——半清态
 * 需管理员重新发起 /wipealldata 收敛（概率低，可人工恢复）。
 */
export async function deleteUserData(
  db: D1Database,
  botId: number,
  userId: number,
  threadId: number,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM messages WHERE bot_id = ? AND user_id = ?").bind(botId, userId),
    db.prepare("DELETE FROM topics WHERE bot_id = ? AND user_id = ? AND thread_id = ?").bind(botId, userId, threadId),
    db.prepare("DELETE FROM users WHERE bot_id = ? AND user_id = ?").bind(botId, userId),
    db.prepare("DELETE FROM delete_confirmations WHERE bot_id = ? AND user_id = ?").bind(botId, userId),
  ]);
}

/**
 * 取全部 topic 的 thread_id（T40 确认清库前调用）——topics 表是话题清单的
 * 唯一来源（Bot API 无列举话题方法）。General 话题从不在表内。
 */
export async function listAllTopicThreads(db: D1Database): Promise<number[]> {
  const result = await db
    .prepare("SELECT thread_id FROM topics ORDER BY thread_id")
    .all<{ thread_id: number }>();
  return (result.results ?? []).map((row) => row.thread_id);
}

export async function wipeAllUserData(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM users").run();
  await db.prepare("DELETE FROM topics").run();
  await db.prepare("DELETE FROM messages").run();
  await db.prepare("DELETE FROM delete_confirmations").run();
  // broadcasts 一并清空（preparing/pending 已置 cancelled、sending 已置 failed；
  // 循环在下一位收件人前停止，但已进入 Telegram 的单条请求无法撤回。General 公告
  // 与控制消息保留在 Telegram 历史中，作为唯一广播历史）
  await db.prepare("DELETE FROM broadcasts").run();
}
