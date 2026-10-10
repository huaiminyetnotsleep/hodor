/**
 * Cloudflare Turnstile Siteverify 客户端。
 *
 * - endpoint 固定为官方地址，绝不接受调用方传入 URL；
 * - 每次调用 5 秒超时；临时性失败（网络错误 / 超时 / 5xx / 非 JSON /
 *   internal-error）最多**追加一次**重试，同一逻辑操作复用同一
 *   idempotency_key（UUID）——新 token / 新操作生成新 key；
 * - 结构化结果 passed / rejected / unavailable：不复用 TelegramResult，
 *   也绝不在 Telegram client 内加 Cloudflare 分支（单一分类点原则的
 *   对称实现——分类只发生在本文件）；
 * - success=true 之后仍必须校验应用预期上下文：hostname / action /
 *   cdata 与预期一致才算 passed（客户端可控 cdata 不能证明身份，它必须
 *   与服务端认证后的当前请求一致）；任何不匹配 → rejected。
 *
 * 安全约束：secret 绝不进日志；unavailable 的 detail 只含已消毒的失败
 * 概要（HTTP 状态 / 概述），不回显请求体。
 */

const SITEVERIFY_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** 单次请求超时（毫秒） */
const TIMEOUT_MS = 5_000;
/** 临时失败的最大追加重试次数（0 = 不重试） */
const MAX_RETRIES = 1;
/** 重试前的固定退避（毫秒；页面侧另有 15 秒服务端节流兜底） */
const RETRY_BACKOFF_MS = 300;

/** 应用侧固定 action（widget 渲染与 Siteverify 校验共用） */
export const TURNSTILE_ACTION = "hodor_verify";

export type TurnstileOutcome =
  | { status: "passed" }
  | { status: "rejected"; errorCodes: string[] }
  | { status: "unavailable"; detail?: string };

export interface SiteverifyParams {
  secret: string;
  /** 用户提交的 Turnstile token（客户端回调产物，非授权结果） */
  token: string;
  /** 预期 hostname（验证页面 origin 的 host） */
  expectedHostname: string;
  /** 预期 action（恒为 TURNSTILE_ACTION） */
  expectedAction: string;
  /** 预期 cdata（= 当前请求 nonce） */
  expectedCdata: string;
  /** 可选可信 remoteip（本仓库不透传不可信头，暂不启用） */
  remoteIp?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** internal-error 是 Cloudflare 侧临时故障（官方错误码表），按不可用处理 */
function isTransientErrorCode(errorCodes: string[]): boolean {
  return errorCodes.includes("internal-error");
}

export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * 单次 Siteverify 调用的响应分类（分类矩阵唯一落点）。
 * transient = 允许同 key 重试一次的网络 / 超时 / 5xx / 非 JSON / internal-error。
 */
async function attempt(
  params: SiteverifyParams,
  idempotencyKey: string,
  fetchImpl: typeof fetch,
): Promise<TurnstileOutcome | "transient"> {
  let response: Response;
  try {
    response = await fetchImpl(SITEVERIFY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: params.secret,
        response: params.token,
        ...(params.remoteIp !== undefined ? { remoteip: params.remoteIp } : {}),
        idempotency_key: idempotencyKey,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return "transient"; // 网络错误 / 超时（含 AbortSignal 触发）
  }

  if (response.status >= 500) return "transient";
  if (response.status !== 200) {
    return {
      status: "unavailable",
      detail: `siteverify HTTP ${response.status}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return "transient"; // 非 JSON：按临时失败处理
  }
  if (!isRecord(body) || typeof body.success !== "boolean") {
    return { status: "unavailable", detail: "siteverify 响应结构异常" };
  }

  const errorCodes = stringArray(body["error-codes"]);
  if (!body.success) {
    if (isTransientErrorCode(errorCodes)) return "transient";
    return { status: "rejected", errorCodes };
  }

  // success=true 也必须核对应用预期上下文（hostname / action / cdata）
  const hostname = typeof body.hostname === "string" ? body.hostname : undefined;
  const action = typeof body.action === "string" ? body.action : undefined;
  const cdata = typeof body.cdata === "string" ? body.cdata : undefined;
  if (
    hostname !== params.expectedHostname ||
    action !== params.expectedAction ||
    cdata !== params.expectedCdata
  ) {
    return { status: "rejected", errorCodes: ["context-mismatch"] };
  }
  return { status: "passed" };
}

/**
 * 校验一个 Turnstile token：临时失败重试恰好一次（同 key），其余结果直接
 * 透传。调用方必须先完成本地身份 / 请求预检再调用本函数（不拿上游当
 * 垃圾过滤器），但预检结果不是最终授权——最终裁决在 D1 条件 CAS。
 */
export async function verifyTurnstileToken(
  params: SiteverifyParams,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileOutcome> {
  const idempotencyKey = generateIdempotencyKey();
  const first = await attempt(params, idempotencyKey, fetchImpl);
  if (first !== "transient") return first;
  if (MAX_RETRIES < 1) {
    return { status: "unavailable", detail: "siteverify 暂时不可用" };
  }
  await sleep(RETRY_BACKOFF_MS);
  const second = await attempt(params, idempotencyKey, fetchImpl);
  if (second !== "transient") return second;
  return { status: "unavailable", detail: "siteverify 暂时不可用，请稍后重试" };
}
