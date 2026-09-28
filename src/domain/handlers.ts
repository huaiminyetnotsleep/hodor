/**
 * domain · Update 处理器注册表（S3，design.md 模块契约）。
 *
 * 处理器签名是全 pipeline 的唯一入口契约（docs/01：业务逻辑与触发方式解耦）：
 * - ctx 只含 env / db / telegram / bot / update，不含 Request 与 ExecutionContext——
 *   pipeline 不感知触发方式（docs/08：Phase 2 由 Queue 消费调用同一管线，禁止 waitUntil）；
 * - 抛错 = 本次处理失败 → inbox 状态机置 5xx 让 Telegram 重投（docs/03）；
 *   「拒绝服务/永久错误不是故障」的分支（blocked、400 毒丸）由处理器自行标记
 *   processed 后正常返回，不得抛错（docs/03 错误分类）。
 *
 * S4/S5/S6 起 inbound/outbound/command 槽位均挂载真实实现。
 */
import type { TelegramClient, TelegramUpdate } from '../telegram';
import type { Env } from '../types';
import type { Bot } from '../store';
import type { UpdateSource } from './classify';
import { handleInbound } from '../pipeline/inbound/handler';
import { handleOutbound } from '../pipeline/outbound/handler';
import { handleCommand } from '../pipeline/commands/handler';

export interface UpdateContext {
  env: Env;
  db: D1Database;
  telegram: TelegramClient;
  bot: Bot;
  update: TelegramUpdate;
}

export type UpdateHandler = (ctx: UpdateContext) => Promise<void>;

/** classify 的 'ignore' 不进任何业务管线（router 直接标记 processed），故注册表只有三个键 */
type DispatchableSource = Exclude<UpdateSource, 'ignore'>;

const registry: Record<DispatchableSource, UpdateHandler> = {
  // S4：入站中继（用户私聊 → Topic，docs/02/03；handleInbound 经子路径引入，无运行时环）
  inbound: handleInbound,
  // S5：出站中继（Topic 回复 → 用户私聊 + 403 处理，docs/03；同样经子路径引入）
  outbound: handleOutbound,
  // S6：管理命令（/ban /unban；白名单前置 → parse → dispatch → 删命令消息，docs/04；
  // 命令先于中继、绝不进 copyMessage——classify 分流保证）
  command: handleCommand,
};

export function getUpdateHandler(source: DispatchableSource): UpdateHandler {
  return registry[source];
}

/**
 * 处理器注入点：测试打桩替换（docs/10）。
 * 仅应在本模块与测试中使用，业务代码不得在请求路径上调用。
 */
export function setUpdateHandler(source: DispatchableSource, handler: UpdateHandler): void {
  registry[source] = handler;
}
