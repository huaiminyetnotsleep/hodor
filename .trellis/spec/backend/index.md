# Backend Development Guidelines

> Project-specific conventions for the hodor Worker (Cloudflare Workers + D1 + Telegram).

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Environment & Configuration](./env-config.md) | Env bindings, `.dev.vars` single-point config, `Cloudflare.Env` merge | Filled (S1) |
| [Error Handling](./error-handling.md) | Telegram tri-state result language, classification matrix, consumer rules | Filled (S2) |
| [Testing Setup](./testing.md) | vitest-pool-workers 0.22 + Vitest 4 wiring, migrations injection | Filled (S1) |

Add new guideline files here as conventions are established (one file per topic, linked from
this table). Cross-cutting thinking checklists live in [../guides/index.md](../guides/index.md).

---

**Language**: All documentation should be written in **English**.
