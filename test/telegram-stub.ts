/**
 * test 共用 · telegram fetch 桩（docs/10：fetch 层打桩，不发起真实网络）。
 * 由 inbound-handler.test.ts（S4）与 outbound-handler.test.ts（S5）共用——
 * 桩按 method + 入参返回编排结果并记录调用，未编排的 method 直接抛错（等价「不得发生」断言）。
 */
import { createTelegramClient, type TelegramClient } from '../src/telegram';

/** 桩返回值：普通结果（包成 200 + ok:true）或 { status, body } 原始响应规格（模拟 4xx/5xx） */
export type StubResult = unknown | { status: number; body: unknown };
export type MethodStub = (payload: Record<string, unknown>) => StubResult;

export interface TelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

function isRawResponse(value: StubResult): value is { status: number; body: unknown } {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

export function makeTelegram(handlers: Record<string, MethodStub>): { telegram: TelegramClient; calls: TelegramCall[] } {
  const calls: TelegramCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = /\/bot[^/]+\/([A-Za-z]+)/.exec(String(input))?.[1] ?? '';
    const payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    calls.push({ method, payload });
    const respond = handlers[method];
    if (respond === undefined) {
      throw new Error(`telegram stub: unexpected method ${method}`); // 等价「不得发生」断言
    }
    const out = respond(payload);
    if (isRawResponse(out)) {
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: out }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { telegram: createTelegramClient({ botToken: 'test-token', fetchImpl }), calls };
}

export const callsOf = (calls: TelegramCall[], method: string): TelegramCall[] => calls.filter((c) => c.method === method);
