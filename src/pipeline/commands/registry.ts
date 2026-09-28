/**
 * pipeline.commands · 命令解析与注册表（S6，docs/04「命令优先级」、docs/03 来源分类）。
 *
 * - parseCommand 纯函数：`/cmd`、`/cmd@BotName`、`/cmd args...`；命令名大小写不敏感
 *   （规范化为小写）；`@BotName` 后缀从首词剥离（Telegram 群内命令惯例，docs/04）；
 * - 注册表：name → CommandHandler（S6 注册 ban/unban，S7 追加 risk/unrisk；S8 再追加
 *   purge/deluser，docs/04「命令注册」：解析与执行不依赖 setMyCommands 菜单）；
 * - 命令绝不进入 copyMessage（classify 分流 + S5 注册表保证）；本模块不做 IO。
 */
import type { UpdateContext } from '../../domain';
import { banCustomer, unbanCustomer } from './ban';
import { riskCustomer, unriskCustomer } from './risk';
import { purgeCustomer, delUser } from './danger';

export interface ParsedCommand {
  /** 小写规范名（大小写不敏感；`@BotName` 后缀已剥离） */
  name: string;
  /** 首词之后的剩余文本（仅去前导空白；S8 /purge confirm <id> 子命令消费） */
  args: string;
}

/**
 * 文本 → 命令解析（纯函数，docs/03「命令必须在普通中继逻辑之前解析」）：
 * 非 `/` 前缀或裸 `/`、`/@Bot`（无命令名）→ null，调用方按未知来源静默处理。
 */
export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) {
    return null;
  }
  const body = text.slice(1);
  const firstWhitespace = body.search(/\s/);
  const token = firstWhitespace === -1 ? body : body.slice(0, firstWhitespace);
  const atSign = token.indexOf('@');
  const name = (atSign === -1 ? token : token.slice(0, atSign)).toLowerCase();
  if (name.length === 0) {
    return null; // 无命令名（裸 `/` 或 `/@Bot`）
  }
  const args = firstWhitespace === -1 ? '' : body.slice(firstWhitespace + 1).trimStart();
  return { name, args };
}

/** 命令处理器签名：与 UpdateHandler 同形（ctx 携带全部输入，docs/01 触发方式解耦） */
export type CommandHandler = (ctx: UpdateContext) => Promise<void>;

/** 命令注册表（键 = parseCommand 产物 name；只读，docs/04 命令全集至此收齐） */
const commandRegistry: ReadonlyMap<string, CommandHandler> = new Map([
  ['ban', banCustomer],
  ['unban', unbanCustomer],
  ['risk', riskCustomer],
  ['unrisk', unriskCustomer],
  ['purge', purgeCustomer],
  ['deluser', delUser],
]);

/** 查命令处理器；未知命令返回 undefined（调用方静默，docs/04：不删消息不中继） */
export function getCommandHandler(name: string): CommandHandler | undefined {
  return commandRegistry.get(name);
}
