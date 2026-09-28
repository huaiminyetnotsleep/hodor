/**
 * admin · POST /admin/admins — 管理员白名单维护（S9，docs/05「管理员白名单」）。
 *
 * body {action:'add'|'remove', user_ids:number[], display_name?:string}（design.md 定稿）：
 * - add：逐个 INSERT … ON CONFLICT DO NOTHING（缺则增）→ audit admin_add；
 * - remove：批量 DELETE → audit admin_remove；不设保留下限（docs/05 未约束）。
 * 每次变更写 audit_logs（docs/05/09）；display_name 非敏感，随 add 入库与审计。
 */
import { isRecord, jsonError, jsonOk } from '../http';
import { AUDIT_ACTIONS, writeAudit } from '../store/audit';
import { findByTelegramBotId } from '../store/bots';
import { addSupportAdmin, removeSupportAdmins } from '../store/support_admins';
import { createTelegramClient } from '../telegram';
import type { AdminSubHandler } from './router';

export const handleAdmins: AdminSubHandler = async (request, env, _ctx) => {
  let body: Record<string, unknown>;
  const rawBody = (await request.text()).trim();
  if (rawBody.length === 0) {
    return jsonError(400, 'request body is required: {action, user_ids}');
  }
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!isRecord(parsed)) {
      return jsonError(400, 'request body must be a JSON object');
    }
    body = parsed;
  } catch {
    return jsonError(400, 'request body is not valid JSON');
  }

  const action = body['action'];
  if (action !== 'add' && action !== 'remove') {
    return jsonError(400, "action must be 'add' or 'remove'");
  }
  const userIds = body['user_ids'];
  if (!Array.isArray(userIds) || !userIds.every((item) => typeof item === 'number' && Number.isSafeInteger(item))) {
    return jsonError(400, 'user_ids must be an array of integers');
  }

  let displayName: string | undefined;
  if (body['display_name'] !== undefined) {
    if (typeof body['display_name'] !== 'string') {
      return jsonError(400, 'display_name must be a string');
    }
    displayName = body['display_name'];
  }

  const telegram = createTelegramClient({ botToken: env.TELEGRAM_BOT_TOKEN });
  const me = await telegram.getMe();
  if (!me.ok) {
    return jsonError(502, `getMe failed (${me.kind}): ${me.errorMessage ?? 'unknown error'}`);
  }
  const bot = await findByTelegramBotId(env.DB, me.result.id);
  if (bot === undefined) {
    return jsonError(404, 'bot is not initialized: POST /admin/setup first');
  }

  if (action === 'add') {
    let added = 0;
    for (const userId of userIds) {
      if (await addSupportAdmin(env.DB, bot.id, userId, displayName)) {
        added += 1;
      }
    }
    await writeAudit(env.DB, {
      botId: bot.id,
      actorType: 'system',
      action: AUDIT_ACTIONS.adminAdd,
      detail: { user_ids: userIds, added, ...(displayName !== undefined && { display_name: displayName }) },
    });
    return jsonOk({ action, added });
  }

  const removed = await removeSupportAdmins(env.DB, bot.id, userIds);
  await writeAudit(env.DB, {
    botId: bot.id,
    actorType: 'system',
    action: AUDIT_ACTIONS.adminRemove,
    detail: { user_ids: userIds, removed },
  });
  return jsonOk({ action, removed });
};
