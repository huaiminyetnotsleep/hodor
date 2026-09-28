/**
 * Env 绑定契约。唯一事实源 = worker-configuration.d.ts（wrangler types 生成，含 DB 绑定）
 * + src/env.d.ts（命名空间合并补充 7 个环境变量与测试注入字段）。本文件仅做别名导出。
 *
 * 分层约定（2026-09-28 定稿）：7 个变量全部经面板「变量和机密」或 .dev.vars/secret 注入，
 * 仓库不含任何值；wrangler.jsonc 的 keep_vars: true 保证面板变量跨部署持久（Secret 本就永不因部署删除）。
 */
export type Env = Cloudflare.Env;

