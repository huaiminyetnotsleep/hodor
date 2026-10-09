/**
 * GET /verify + POST /api/verify/turnstile（Turnstile 任务；design.md §4）。
 *
 * GET：安全静态页面（CSP nonce / no-store / Referrer-Policy / nosniff）。
 * r 必须符合 nonce 格式；页面绝不根据 r 输出用户资料，nonce 也不是身份。
 *
 * POST（唯一完成入口）：严格 JSON（≤ 16 KiB，读 body 计量而非仅信
 * Content-Length）；输入只收 requestId / initData / turnstileToken——客户端
 * 自报的 userId / botId 绝不当授权依据。固定顺序（design §8）：
 *   来源校验（Origin 可选匹配）→ bot/config 就绪 → initData HMAC 身份 →
 *   请求预检（归属 / 用户不符 / 封禁 / 已验证 / hash / 配置版本 / 过期）→
 *   15 秒原子认领提交窗口（不调上游）→ Siteverify（成功也核对 hostname /
 *   action / cdata）→ await 后用最新 now 复核身份年龄 → 单条条件 UPDATE
 *   最终 CAS（meta.changes=1 才算通过）→ warn 策略成功通知 → 200。
 *
 * 错误码矩阵（稳定 code + 中文可操作信息，绝不回显原始输入 / 上游凭据）：
 * 400 参数非法 / 401 身份缺失或签名、时间无效 / 403 用户不符、封禁、来源
 * 不符 / 404 用户不存在（绝不 ensureUser 重建）/ 409 旧请求、配置变化、
 * 并发已消费 / 410 当前请求过期 / 413 超大请求 / 422 token 被拒或上下文
 * 不匹配 / 429 提交过频（Retry-After）/ 503 配置、数据库或上游不可用。
 * 不开放任意 CORS（无宽 Access-Control 头）；GET 永远不能消费请求。
 */
import { parsePublicBaseUrl } from "../env";
import { announceVerificationPassed } from "../pipeline/verify";
import { getSingleBotId } from "../store/bots";
import { getVerificationSettings } from "../store/settings";
import { nowIso } from "../store/util";
import {
  claimVerifySubmit,
  completeTurnstileVerification,
  findUserIdByRequestHash,
  getVerifyRequestState,
  VERIFY_SUBMIT_THROTTLE_MS,
} from "../store/users";
import { createTelegramClient } from "../telegram/client";
import { renderVerifyPage } from "../verification/page";
import { isVerifyNonceFormat, sha256Hex } from "../verification/request";
import { validateTelegramInitData } from "../verification/telegramInitData";
import { TURNSTILE_ACTION, verifyTurnstileToken } from "../verification/turnstile";

/** 请求体上限（字节）：token ≤2048 + initData ≤8KiB 的裕量上限 */
const MAX_BODY_BYTES = 16 * 1024;

/** 安全响应头公共集（页面与 API 同不缓存、不泄漏 referrer） */
function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...extra,
  };
}

function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ status: "error", code, message }, {
    status,
    headers: baseHeaders(headers),
  });
}

/** 稳定错误码（客户端据此切换状态页；页面不解析 message） */
const ERR = {
  invalid: ["invalid_request", "请求参数无效，请从 Bot 私聊的验证按钮重新打开。"],
  unauthorized: ["unauthorized", "身份信息缺失或已过期：请关闭本页面，回到 Bot 聊天窗口点击「打开验证页面」按钮重新打开。"],
  forbidden: ["forbidden", "无法完成验证：当前账号与验证请求不符。请回到 Bot 聊天窗口重新发起验证。"],
  notFound: ["not_found", "用户不存在：请回到 Bot 聊天窗口重新发送消息。"],
  conflict: ["conflict", "验证请求已失效或已被使用。请回到 Bot 聊天窗口发送任意消息重新获取验证。"],
  expired: ["expired", "验证链接已过期（10 分钟）。请回到 Bot 聊天窗口发送任意消息重新获取验证。"],
  tooLarge: ["payload_too_large", "请求内容超出限制，请重新打开验证页面。"],
  rejected: ["token_rejected", "人机验证未通过，请重新完成验证；多次失败请联系客服。"],
  throttled: ["too_many_requests", "提交过于频繁，请稍候几秒再试。"],
  unavailable: ["unavailable", "验证服务暂时不可用，请稍后重试；多次失败请联系客服。"],
} as const;

export type VerifyErrorCode = keyof typeof ERR;

export function verifyErrorResponse(code: VerifyErrorCode, status: number, headers: Record<string, string> = {}): Response {
  const [name, message] = ERR[code];
  return jsonError(status, name, message, headers);
}

/* ------------------------------------------------------------------ */
/* GET /verify：安全静态页面                                            */
/* ------------------------------------------------------------------ */

export function handleVerifyPage(request: Request, env: Cloudflare.Env): Response {
  const requestId = new URL(request.url).searchParams.get("r");
  if (!isVerifyNonceFormat(requestId)) {
    return new Response("无效的验证链接：请从 Bot 私聊的「打开验证页面」按钮重新打开。", {
      status: 400,
      headers: baseHeaders({ "content-type": "text/plain; charset=utf-8" }),
    });
  }
  // Site Key 是公开标识（可进页面）；Secret 绝不传入本模块
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const page = renderVerifyPage({ requestId, siteKey });
  return new Response(page.html, {
    status: 200,
    headers: baseHeaders({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": page.csp,
      // 刻意不设 frame-ancestors 'none' / X-Frame-Options DENY：Telegram
      // Mini App 需要嵌入本页（design §4）
    }),
  });
}

/* ------------------------------------------------------------------ */
/* POST /api/verify/turnstile：唯一完成入口                             */
/* ------------------------------------------------------------------ */

interface VerifySubmitInput {
  requestId: string;
  initData: string;
  turnstileToken: string;
}

/** 严格形状检查：三个键都必须是 string（多余键忽略——向前兼容不放宽校验） */
function parseSubmitBody(parsed: unknown): VerifySubmitInput | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  const { requestId, initData, turnstileToken } = body;
  if (typeof requestId !== "string" || typeof initData !== "string" || typeof turnstileToken !== "string") {
    return null;
  }
  if (!isVerifyNonceFormat(requestId)) return null;
  if (initData === "" || initData.length > 8 * 1024) return null;
  if (turnstileToken === "" || turnstileToken.length > 2048) return null;
  return { requestId, initData, turnstileToken };
}

export async function handleVerifySubmit(request: Request, env: Cloudflare.Env): Promise<Response> {
  /* ---------------- ① 来源：Origin 存在时必须与页面 origin 一致 ---------------- */
  const pageOrigin = new URL(request.url).origin;
  const originHeader = request.headers.get("origin");
  if (originHeader !== null) {
    let originMatches = false;
    try {
      originMatches = new URL(originHeader).origin === pageOrigin;
    } catch {
      originMatches = false;
    }
    if (!originMatches) {
      return verifyErrorResponse("forbidden", 403);
    }
  }
  // Origin 缺失（非浏览器客户端）不是旁路：后续身份 / 请求 / CAS 校验全部照常

  /* ---------------- ② 方法 / 类型 / 体积 / 形状（不调上游、不改状态） ---------------- */
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return verifyErrorResponse("invalid", 400);
  }
  const raw = await request.text(); // 读 body 计量：不能仅信 Content-Length
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return verifyErrorResponse("tooLarge", 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return verifyErrorResponse("invalid", 400);
  }
  const input = parseSubmitBody(parsed);
  if (input === null) return verifyErrorResponse("invalid", 400);

  /* ---------------- ③ bot / 配置就绪（失败关闭，绝不带空凭据继续） ---------------- */
  const settings = await getVerificationSettings(env.HODOR_DB);
  const botId = await getSingleBotId(env.HODOR_DB);
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (
    botId === null ||
    !settings.verifyEnabled ||
    settings.verifyMode !== "turnstile" ||
    !secretKey ||
    typeof botToken !== "string" ||
    botToken === ""
  ) {
    // bot 未就绪 / 验证已关闭 / 模式已切走 / 凭据缺失：前两者 503（服务侧
    // 未就绪），配置变化一律 409（旧请求不复活）
    if (botId === null || typeof botToken !== "string" || botToken === "" || !secretKey) {
      return verifyErrorResponse("unavailable", 503);
    }
    return verifyErrorResponse("conflict", 409);
  }

  /* ---------------- ④ 身份（Telegram initData HMAC；不向任何上游发送 initData） ---------------- */
  const identity = await validateTelegramInitData(input.initData, botToken, Date.now());
  if (!identity.ok) {
    // format / signature / expired 全部 401：重开（身份过期）或返回 Bot
    return verifyErrorResponse("unauthorized", 401);
  }
  const userId = identity.userId;

  /* ---------------- ⑤ 请求预检（归属 / 用户不符 / 治理态 / 栅栏 / 过期） ---------------- */
  const requestHash = await sha256Hex(input.requestId);
  const nowIsoText = nowIso();
  const state = await getVerifyRequestState(env.HODOR_DB, botId, userId);
  if (state === null) {
    // 用户行不存在（/deluser 后）：绝不 ensureUser / UPSERT 重建
    return verifyErrorResponse("notFound", 404);
  }
  if (state.isBanned) return verifyErrorResponse("forbidden", 403);
  if (state.isVerified) return verifyErrorResponse("conflict", 409); // 已完成，重复提交不再通过
  if (state.verifyRequestHash !== requestHash) {
    // 该 hash 属于另一个用户 → 用户不符（不消费正确用户的请求）；否则旧请求
    const owner = await findUserIdByRequestHash(env.HODOR_DB, botId, requestHash);
    if (owner !== null && owner !== userId) return verifyErrorResponse("forbidden", 403);
    return verifyErrorResponse("conflict", 409);
  }
  if (state.verifyRequestGeneration !== settings.verifyGeneration) {
    return verifyErrorResponse("conflict", 409); // 配置已切换：旧请求作废
  }
  if (
    state.verifyRequestExpiresAt === null ||
    state.verifyRequestExpiresAt <= nowIsoText
  ) {
    return verifyErrorResponse("expired", 410); // ISO 字典序比较（util 契约）
  }

  /* ---------------- ⑥ 15 秒原子认领提交窗口（跨 isolate；失败不调上游） ---------------- */
  const nextNotBefore = new Date(Date.now() + VERIFY_SUBMIT_THROTTLE_MS).toISOString();
  const claimed = await claimVerifySubmit(
    env.HODOR_DB,
    botId,
    userId,
    { hash: requestHash, generation: settings.verifyGeneration },
    { now: nowIsoText, nextNotBefore },
  );
  if (!claimed) {
    let retryAfterSeconds = Math.ceil(VERIFY_SUBMIT_THROTTLE_MS / 1000);
    const notBefore = state.verifySubmitNotBefore;
    if (notBefore !== null && notBefore > nowIsoText) {
      const untilMs = new Date(notBefore).getTime() - Date.now();
      if (Number.isFinite(untilMs) && untilMs > 0) {
        retryAfterSeconds = Math.min(
          Math.ceil(VERIFY_SUBMIT_THROTTLE_MS / 1000),
          Math.max(1, Math.ceil(untilMs / 1000)),
        );
      }
    }
    return verifyErrorResponse("throttled", 429, { "retry-after": String(retryAfterSeconds) });
  }

  /* ---------------- ⑦ Siteverify（成功也核对 hostname / action / cdata） ---------------- */
  const expectedHostname = parsePublicBaseUrl(env)?.hostname ?? new URL(request.url).hostname;
  const outcome = await verifyTurnstileToken({
    secret: secretKey,
    token: input.turnstileToken,
    expectedHostname,
    expectedAction: TURNSTILE_ACTION,
    expectedCdata: input.requestId,
  });
  if (outcome.status === "unavailable") {
    // 上游不可用：冷却保留（不提前清窗口——失败方不得结束冷却），稍后重试
    console.warn(
      `[verify-api] user ${userId}: siteverify 暂时不可用：${outcome.detail ?? "no detail"}`,
    );
    return verifyErrorResponse("unavailable", 503);
  }
  if (outcome.status === "rejected") {
    console.warn(
      `[verify-api] user ${userId}: turnstile token 被拒（${outcome.errorCodes.join(", ") || "no codes"}）`,
    );
    return verifyErrorResponse("rejected", 422);
  }

  /* ---------------- ⑧ await 后用最新 now 复核身份年龄（快照不是最终裁决） ---------------- */
  const rechecked = await validateTelegramInitData(input.initData, botToken, Date.now());
  if (!rechecked.ok || rechecked.userId !== userId) {
    return verifyErrorResponse("unauthorized", 401);
  }

  /* ---------------- ⑨ 单条条件 UPDATE 最终裁决（唯一授权点） ---------------- */
  const finalNow = nowIso();
  const won = await completeTurnstileVerification(
    env.HODOR_DB,
    botId,
    userId,
    { hash: requestHash, generation: settings.verifyGeneration },
    { now: finalNow, submitNotBefore: nextNotBefore },
  );
  if (!won) {
    // Siteverify 等待期间发生变化：按当前状态区分过期（410）与其他冲突（409）
    const latest = await getVerifyRequestState(env.HODOR_DB, botId, userId);
    const expired =
      latest !== null &&
      latest.verifyRequestExpiresAt !== null &&
      latest.verifyRequestExpiresAt <= finalNow;
    return verifyErrorResponse(expired ? "expired" : "conflict", expired ? 410 : 409);
  }

  /* ---------------- ⑩ 成功通知（web 策略：D1 已提交，任何失败都 warn 不回滚） ---------------- */
  const client = createTelegramClient(botToken);
  if (state.verifyMsgId !== null) {
    try {
      await announceVerificationPassed(
        env,
        client,
        botId,
        userId,
        { chatId: userId, messageId: state.verifyMsgId },
        "web",
      );
    } catch (error) {
      // announce 的 web 策略内部已不抛；此兜底保证通知面任何意外都不影响 200
      console.warn(
        `[verify-api] user ${userId}: 成功通知失败（不影响验证结果）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return Response.json(
    { status: "verified" },
    { headers: baseHeaders() },
  );
}
