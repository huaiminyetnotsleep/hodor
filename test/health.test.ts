import { expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { APP_VERSION } from '../src/version';

it('GET /health 返回 200 与版本，且响应体无多余键（无敏感信息）', async () => {
  const res = await SELF.fetch('https://example.com/health');

  expect(res.status).toBe(200);
  // toEqual 全量比对：多出任何键（配置、Secret、环境）都算失败（docs/09）
  expect(await res.json()).toEqual({ ok: true, version: APP_VERSION });
});

it('GET /health 之外未挂载的路由返回 404', async () => {
  const res = await SELF.fetch('https://example.com/nope');
  expect(res.status).toBe(404);
});
