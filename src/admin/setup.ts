/**
 * admin · POST /admin/setup — 初始化与绑定（S9，docs/05「初始化与绑定流程」9 步逐条）。
 *
 *   ① 解析请求体 {support_chat_id?, admin_ids?}，缺省回退 env（SUPPORT_CHAT_ID / ADMIN_IDS
 *      逗号分隔）；两者都无 → 400（字段名即实现契约，design.md 定稿）
 *   ② getMe 验 env Token → retryable/permanent 失败 → 502 带说明，不落库
 *   ③ upsert bots 行：webhook_key 随机 16 hex（ON CONFLICT 不改 key——Webhook URL 长期稳定，
 *      docs/05）、webhook_secret_hash=SHA-256(env)、support_chat_id、status='active'、
 *      config_version+1
 *   ④ 白名单 upsert：admin_ids 缺则增、不删除（docs/05 明确；删除走 /admin/admins）
 *   ⑤ setWebhook：url=<请求 origin>/telegram/webhook/<webhook_key>、secret_token=env 原文、
 *      allowed_updates=["message"]；失败 → 502（bot 行已 seed，重跑幂等）
 *   ⑥ setMyCommands（BotCommandScopeChat 群级，docs/04）：失败非致命——audit 记 last_error，不阻断
 *   ⑦ getWebhookInfo 核对回读
 *   ⑧ audit webhook_bind（actor_type='system'，detail 只含上下文 ID，不含 Secret/hash 值）
 *   ⑨ 幂等：upsert 语义，重复调用安全，重绑不必先 unbind（docs/05「解绑与重绑」）
 */
import { sha256Hex } from '../crypto';
import { isRecord, jsonError, jsonOk } from '../http';
import { AUDIT_ACTIONS, writeAudit } from '../store/audit';
import { upsertBotForSetup } from '../store/bots';
import { addSupportAdmin } from '../store/support_admins';
import { createTelegramClient, type TelegramBotCommand } from '../telegram';
import type { AdminSubHandler } from './router';

/**
 * 支持群命令菜单（docs/04「命令注册」表格定稿；解析与执行不依赖菜单，注册只为输入体验）。
 * 命令集与 docs/04「命令注册」表格一致：ban/unban/risk/unrisk/purge/deluser。
 */
const SUPPORT_COMMANDS: readonly TelegramBotCommand[] = [
  { command: 'ban', description: '封禁当前 Topic 绑定的用户' },
  { command: 'unban', description: '解除当前 Topic 用户的封禁' },
  { command: 'risk', description: '将当前 Topic 用户列入高危名单（仍可正常对话，持续提示）' },
  { command: 'unrisk', description: '将当前 Topic 用户移出高危名单' },
  { command: 'purge', description: '清除当前 Topic 用户的全部会话数据（不可逆，需二次确认）' },
  { command: 'deluser', description: '删除当前 Topic 用户及其全部数据（不可逆，需二次确认）' },
];

/** 环境变量整数解析：缺失/空白/非法 → undefined（env 是引导通道，静默回退） */
function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** ADMIN_IDS（逗号分隔）解析：缺失/空白 → undefined；非法条目跳过 */
function parseIntegerList(value: string | undefined): number[] | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((parsed) => Number.isSafeInteger(parsed));
}

export const handleSetup: AdminSubHandler = async (request, env, _ctx) => {
  const telegram = createTelegramClient({ botToken: env.TELEGRAM_BOT_TOKEN });

  // ① 请求体优先，缺省回退 env（docs/05：请求体可空）；非法类型显式 400 不静默回退
  let body: Record<string, unknown> = {};
  const rawBody = (await request.text()).trim();
  if (rawBody.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!isRecord(parsed)) {
        return jsonError(400, 'request body must be a JSON object');
      }
      body = parsed;
    } catch {
      return jsonError(400, 'request body is not valid JSON');
    }
  }

  let supportChatId: number | undefined;
  if (body['support_chat_id'] !== undefined) {
    const value = body['support_chat_id'];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      return jsonError(400, 'support_chat_id must be an integer');
    }
    supportChatId = value;
  } else {
    supportChatId = parseInteger(env.SUPPORT_CHAT_ID);
  }

  let adminIds: number[] | undefined;
  if (body['admin_ids'] !== undefined) {
    const value = body['admin_ids'];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'number' && Number.isSafeInteger(item))) {
      return jsonError(400, 'admin_ids must be an array of integers');
    }
    adminIds = value;
  } else {
    adminIds = parseIntegerList(env.ADMIN_IDS);
  }

  if (supportChatId === undefined || adminIds === undefined) {
    return jsonError(400, 'support_chat_id and admin_ids are required (request body or SUPPORT_CHAT_ID/ADMIN_IDS env)');
  }

  // ② getMe 验 Token；失败（retryable/permanent）→ 502，不落库
  const me = await telegram.getMe();
  if (!me.ok) {
    return jsonError(502, `getMe failed (${me.kind}): ${me.errorMessage ?? 'unknown error'}`);
  }

  // ③ seed/upsert bots 行（重复 setup 保留 webhook_key，docs/05）
  const bot = await upsertBotForSetup(env.DB, {
    telegramBotId: me.result.id,
    webhookSecretHash: await sha256Hex(env.TELEGRAM_WEBHOOK_SECRET),
    supportChatId,
  });

  // ④ 白名单 upsert：缺则增、不删除（docs/05）
  for (const adminId of adminIds) {
    await addSupportAdmin(env.DB, bot.id, adminId);
  }

  // ⑤ setWebhook：url 由请求 URL 推导（origin + 路径），secret_token 为 env 原文
  const webhookUrl = `${new URL(request.url).origin}/telegram/webhook/${bot.webhook_key}`;
  const set = await telegram.setWebhook({
    url: webhookUrl,
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
    allowedUpdates: ['message'], // docs/03 显式决策
  });
  if (!set.ok) {
    return jsonError(502, `setWebhook failed (${set.kind}): ${set.errorMessage ?? 'unknown error'}`);
  }

  // ⑥ setMyCommands 群级 scope（docs/04）；失败非致命——audit 带 last_error，不阻断
  const commands = await telegram.setMyCommands({
    commands: SUPPORT_COMMANDS,
    scope: { type: 'chat', chat_id: bot.support_chat_id },
  });
  const commandsError = commands.ok
    ? undefined
    : `setMyCommands failed (${commands.kind}): ${commands.errorMessage ?? 'unknown error'}`;

  // ⑦ getWebhookInfo 核对回读
  const info = await telegram.getWebhookInfo();
  const infoError = info.ok ? undefined : `getWebhookInfo failed (${info.kind}): ${info.errorMessage ?? 'unknown error'}`;

  // ⑧ audit webhook_bind：system 操作者，detail 只含上下文 ID，绝无 Secret/hash 值（docs/06）
  await writeAudit(env.DB, {
    botId: bot.id,
    actorType: 'system',
    action: AUDIT_ACTIONS.webhookBind,
    detail: {
      bot_id: bot.telegram_bot_id,
      webhook_key: bot.webhook_key,
      support_chat_id: bot.support_chat_id,
      admin_count: adminIds.length,
      ...(commandsError !== undefined && { set_my_commands_error: commandsError }),
      ...(infoError !== undefined && { webhook_info_error: infoError }),
    },
  });

  if (!info.ok) {
    return jsonError(502, infoError ?? 'getWebhookInfo failed');
  }

  // ⑨ 响应：{ok, bot_id, webhook_key, webhook 信息原样}
  return jsonOk({ bot_id: bot.telegram_bot_id, webhook_key: bot.webhook_key, webhook: info.result });
};
