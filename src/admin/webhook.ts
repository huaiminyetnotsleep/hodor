/**
 * admin · POST /admin/webhook/status、POST /admin/webhook/unbind（S9，docs/05）。
 *
 * - status：getWebhookInfo 透出（URL / pending / last_error / allowed_updates），纯透传不碰 D1；
 * - unbind：deleteWebhook，drop_pending_updates 缺省 false（保留积压，docs/05「解绑与重绑」）；
 *   成功后写 audit webhook_unbind（system 操作者）。绑定/解绑前后都可用 status 核对。
 *
 * status 为纯透传（不调 getMe、不碰 D1）；unbind 的 env Token 经 getMe 定位 bots 事实源行
 * （docs/05：env 是引导通道，D1 才是事实源）；
 * unbind 在 bot 行不存在（未跑过 setup）时返回 404 引导先初始化。
 */
import { isRecord, jsonError, jsonOk } from '../http';
import { AUDIT_ACTIONS, writeAudit } from '../store/audit';
import { findByTelegramBotId } from '../store/bots';
import { createTelegramClient } from '../telegram';
import type { AdminSubHandler } from './router';

export const handleWebhookStatus: AdminSubHandler = async (_request, env, _ctx) => {
  const telegram = createTelegramClient({ botToken: env.TELEGRAM_BOT_TOKEN });
  const info = await telegram.getWebhookInfo();
  if (!info.ok) {
    return jsonError(502, `getWebhookInfo failed (${info.kind}): ${info.errorMessage ?? 'unknown error'}`);
  }
  return jsonOk({ webhook: info.result });
};

export const handleWebhookUnbind: AdminSubHandler = async (request, env, _ctx) => {
  // 可选 body {drop_pending_updates?: boolean}；空请求体 = 缺省 false（保留积压，docs/05）
  let dropPendingUpdates = false;
  const rawBody = (await request.text()).trim();
  if (rawBody.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return jsonError(400, 'request body is not valid JSON');
    }
    if (!isRecord(parsed)) {
      return jsonError(400, 'request body must be a JSON object');
    }
    const value = parsed['drop_pending_updates'];
    if (value !== undefined && typeof value !== 'boolean') {
      return jsonError(400, 'drop_pending_updates must be a boolean');
    }
    dropPendingUpdates = value ?? false;
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

  const deleted = await telegram.deleteWebhook({ dropPendingUpdates });
  if (!deleted.ok) {
    return jsonError(502, `deleteWebhook failed (${deleted.kind}): ${deleted.errorMessage ?? 'unknown error'}`);
  }

  await writeAudit(env.DB, {
    botId: bot.id,
    actorType: 'system',
    action: AUDIT_ACTIONS.webhookUnbind,
    detail: { telegram_bot_id: bot.telegram_bot_id, drop_pending_updates: dropPendingUpdates },
  });
  return jsonOk({ drop_pending_updates: dropPendingUpdates });
};
