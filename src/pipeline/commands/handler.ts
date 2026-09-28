/**
 * pipeline.commands · 命令入口（S6，docs/04「命令优先级」+ design.md 命令执行语义）。
 *
 * 编排（classify 已把 `/` 前缀群 Topic 文本分流到本处理器，docs/03 来源分类）：
 *   ① 前置白名单：发送者不在 support_admins → 整体静默 return（不解析、不删消息、不审计，
 *      docs/04「白名单外不可执行」+ docs/03 忽略策略「支持群内非白名单成员的消息 → 忽略」）
 *   ② 支持群校验：chat.id === bot.support_chat_id（docs/04 /ban 步骤 2；classify 不看 chat.id）
 *   ③ parseCommand → 未知命令静默 return（不删消息不中继，docs/04）
 *   ④ dispatch（删命令消息 / 审计由各命令处理器按 docs/04 步序执行——忽略分支先于删除，
 *      失败的命令不留「消息消失但什么都没发生」的假象）
 *
 * 命令绝不进入 copyMessage（S5 分流保证）；本处理器正常返回即 processed（docs/03：
 * 「拒绝服务/命令执行」是正常业务结果，不是故障）。
 */
import { findByBotAndUser } from '../../store';
import type { UpdateHandler } from '../../domain';
import { getCommandHandler, parseCommand } from './registry';

export const handleCommand: UpdateHandler = async (ctx) => {
  const { db, bot, update } = ctx;
  const message = update.message;
  if (message === undefined) return; // classify 已保证 message 存在；防御（docs/03 判空原则）

  // ── ① 前置白名单（docs/04 步骤 1：白名单外不可执行，先于解析/删除/审计）────────────
  const from = message.from;
  if (from === undefined) return; // 匿名身份无法核对白名单 → 静默
  const admin = await findByBotAndUser(db, bot.id, from.id);
  if (admin === undefined) return;

  // ── ② 支持群校验（docs/04 步骤 2；非支持群来源一律忽略）────────────────────────────
  if (message.chat.id !== bot.support_chat_id) return;

  // ── ③ 解析（未知命令 / 无命令名 → 静默，docs/04：不删消息不中继）───────────────────
  const text = message.text;
  if (text === undefined) return; // classify 只对 text 分流命令；防御
  const parsed = parseCommand(text);
  if (parsed === null) return;
  const command = getCommandHandler(parsed.name);
  if (command === undefined) return;

  // ── ④ dispatch（命令消息删除与审计在处理器内按 docs/04 步序执行）──────────────────
  await command(ctx);
};
