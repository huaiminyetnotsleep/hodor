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
 * 本任务（S4）起 inbound 槽位挂载真实入站中继；S6 注入 command。
 */
import type { TelegramClient, TelegramUpdate } from '../telegram';
import type { Env } from '../types';
import type { Bot } from '../store';
import type { UpdateSource } from './classify';
import { handleInbound } from '../pipeline/inbound/handler';

export interface UpdateContext {
  env: Env;
  db: D1Database;
  telegram: TelegramClient;
  bot: Bot;
  update: TelegramUpdate;
}

export type UpdateHandler = (ctx: UpdateContext) => Promise<void>;

/** classify 的 'ignore' 不进任何业务管线（router 直接标记 processed），故注册表只有两个键 */
type DispatchableSource = Exclude<UpdateSource, 'ignore'>;

const registry: Record<DispatchableSource, UpdateHandler> = {
  // S4：入站中继（用户私聊 → Topic，docs/02/03；handleInbound 经子路径引入，无运行时环）
  inbound: handleInbound,
  // 占位：S6 注入管理命令分发（/ban /unban /risk /unrisk /purge /deluser，docs/04）
  command: async () => {},
};

export function getUpdateHandler(source: DispatchableSource): UpdateHandler {
  return registry[source];
}

/**
 * 处理器注入点：测试打桩替换（docs/10），以及 S6 命令注册表接入时替换 command。
 * 仅应在本模块与测试中使用，业务代码不得在请求路径上调用。
 */
export function setUpdateHandler(source: DispatchableSource, handler: UpdateHandler): void {
  registry[source] = handler;
}
