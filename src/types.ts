/**
 * Env 绑定契约。唯一事实源 = worker-configuration.d.ts（wrangler types 生成，含 DB 绑定）
 * + src/env.d.ts（命名空间合并补充 7 个环境变量与测试注入字段）。本文件仅做别名导出。
 *
 * Secret 与配置值经环境注入：本地 .dev.vars（模板 .dev.vars.example），
 * 远端 `wrangler secret put`——值不出现在任何被提交的文件里。
 */
export type Env = Cloudflare.Env;

