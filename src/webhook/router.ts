/**
 * webhook · POST /telegram/webhook/:webhook_key（S3，docs/03/05，全项目唯一数据面入口）。
 *
 * 编排（docs/03「处理顺序总览」①②③④）：
 *   webhook_key 查 bots 行（查无 → 404；webhook_key 仅混淆不鉴权，docs/05）
 *   → Secret 头 SHA-256 与 bots.webhook_secret_hash 常量时间比较（缺失/不匹配 → 401，
 *     零业务写入、零业务日志——docs/09 安全清单硬约束）
 *   → 判空：update_id 缺失/非法或非 JSON payload → 静默 200，不登记不处理（docs/03）
 *   → registerUpdate（幂等登记）→ classifyUpdate（来源分类）
 *   → processUpdate（状态机；'ignore' 不进业务管线直接标记 processed）
 *
 * 响应只携带状态码：200 = 已处理/已吸收，5xx = 处理失败待重投，401/404 = 拒绝。
 */
import { classifyUpdate, getUpdateHandler, type UpdateContext } from '../domain';
import { sha256Hex, timingSafeEqual } from '../crypto';
import { isRecord } from '../http';
import { processUpdate, registerUpdate, resolveMaxAttempts } from '../inbox';
import { findByWebhookKey } from '../store';
import { createTelegramClient, type TelegramUpdate } from '../telegram';
import type { Env } from '../types';

const PATH_PREFIX = '/telegram/webhook/';
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

function emptyOk(): Response {
  return new Response(null, { status: 200 });
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST') {
    return notFound(); // 唯一 GET 是 /health（docs/05）
  }
  const webhookKey = url.pathname.slice(PATH_PREFIX.length);
  if (webhookKey.length === 0) {
    return notFound();
  }

  const bot = await findByWebhookKey(env.DB, webhookKey);
  if (bot === undefined) {
    return notFound(); // webhook_key 查无此行 → 404，与 Secret 对错无关（docs/05）
  }

  // Secret 校验：401 路径在此返回，此前此后均无任何业务写入与日志（docs/09）
  const secretHeader = request.headers.get(SECRET_HEADER);
  if (secretHeader === null || !timingSafeEqual(await sha256Hex(secretHeader), bot.webhook_secret_hash)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 判空原则（docs/03）：内容字段全可选，update_id 缺失/非法的 payload 静默 200
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return emptyOk(); // 非 JSON：静默吸收
  }
  if (!isRecord(parsed) || typeof parsed['update_id'] !== 'number' || !Number.isInteger(parsed['update_id'])) {
    return emptyOk();
  }
  // 原始信封整体透传（payload_json 存原样 Update，docs/06）；内容字段只经类型声明消费
  const update = parsed as unknown as TelegramUpdate;

  const telegram = createTelegramClient({ botToken: env.TELEGRAM_BOT_TOKEN });
  const ctx: UpdateContext = { env, db: env.DB, telegram, bot, update };

  // ①② 幂等登记 → ③ 来源分类 → 状态机推进（inbound/outbound/command 槽位均挂真实实现）
  const registration = await registerUpdate(env.DB, bot.id, update);
  const source = classifyUpdate(update, bot.telegram_bot_id);
  const handler = source === 'ignore' ? null : getUpdateHandler(source);
  const result = await processUpdate(ctx, registration, handler, resolveMaxAttempts(env.MAX_ATTEMPTS));

  // 所有关键写入已在 processUpdate 内 await 完成，此处返回即代表处理完成（docs/08）
  return new Response(null, { status: result.httpStatus });
}
