# Testing Setup (vitest-pool-workers 0.22 + Vitest 4)

> How the Worker test harness is wired. Established in S1 (2026-09-28).

---

## Scenario: adding or running Worker tests

### 1. Scope / Trigger

Any `test/*.test.ts` that needs `SELF.fetch`, D1 bindings, or `cloudflare:test` imports.

### 2. Signatures

```ts
// vitest.config.ts — TWO hooks are required (0.22 API; defineWorkersConfig is REMOVED):
import { defineConfig } from 'vitest/config';
import { cloudflarePool, cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations/', import.meta.url).pathname);
  const workers = {
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
  };
  return {
    plugins: [cloudflareTest(workers)],
    test: {
      pool: 'cloudflare-pool',                 // must equal cloudflarePool(...).name
      poolRunner: cloudflarePool(workers),
    },
  };
});
```

```ts
// test/*.test.ts — migrations are applied per test file against the isolated local D1
import { applyD1Migrations, env } from 'cloudflare:test';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // seed parent rows (bots → customers → …) to satisfy FK
});
```

### 3. Contracts

- Version pairing is strict: `@cloudflare/vitest-pool-workers@0.22.x` peer-requires `vitest@^4.1.0`.
  Vitest 5.x fails with `Missing "./config" specifier`.
- `test/cloudflare-test-env.d.ts` merges `TEST_MIGRATIONS: D1Migration[]` into `Cloudflare.Env`;
  tsconfig `types` must be `["@cloudflare/vitest-pool-workers/types"]` (the `cloudflare:test`
  ambient module lives in that subpath since 0.22), plus the generated `worker-configuration.d.ts`
  included in `include`.

### 4. Validation & Error Matrix

- `compatibility_date` newer than the bundled workerd supports → startup error
  `This Worker requires compatibility date …`. Pin to the workerd cap (currently `2026-08-22`).
- `node:fs` inside a test (workerd sandbox) → `no such file or directory`. Read files on the Node
  side (`readD1Migrations`, config) and inject via bindings instead.
- Pool name mismatch (`test.pool` ≠ `cloudflare-pool`) → `Runner … is not supported`.

### 5. Good / Base / Bad Cases

- **Good**: new test file applies migrations in `beforeAll`, seeds only FK parents it needs.
- **Base**: test needs only routing → `SELF.fetch` against `main` from wrangler.jsonc.
- **Bad**: sharing mutated DB state across test files (storage is isolated per file — rely on it,
  re-seed per file), or hand-rolling a second migration applier.

### 6. Tests Required

- Every schema-adjacent change (S2+) updates `test/schema.test.ts` assertions in the same task.
- Data-layer rules (docs/10): unique-index conflict via `INSERT … ON CONFLICT DO NOTHING` +
  `meta.changes`; CHECK constraints reject invalid state values.

### 7. Wrong vs Correct

#### Wrong

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'; // export removed in 0.22
```

#### Correct

```ts
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers';
export default defineConfig({
  plugins: [cloudflareTest(workers)],
  test: { pool: 'cloudflare-pool', poolRunner: cloudflarePool(workers) },
});
```

**Why**: 0.22 restructured the package around Vitest 4's custom-pool protocol; the plugin provides
the `cloudflare:test` virtual module, the poolRunner registers the runtime.
