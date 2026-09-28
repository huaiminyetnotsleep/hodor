/**
 * 环境变量类型补充。
 * `wrangler types` 只覆盖 wrangler.jsonc 里的绑定（DB）；以下 7 个变量由环境注入——
 * 本地读 .dev.vars（模板 .dev.vars.example），远端 `wrangler secret put`——
 * 值不出现在任何被提交的文件里（2026-09-28 决策：配置单点 .dev.vars，docs/05 的
 * [vars] 分层方案按用户要求调整为此形式）。
 *
 * 代码消费约定（S2+ 遵守）：
 * - ALLOW_UNKNOWN_USERS：仅显式 "false" 视为关闭，缺省/其他值一律 true；
 * - MAX_ATTEMPTS：缺失或非法时取默认 8。
 */
declare global {
  namespace Cloudflare {
    interface Env {
      // ── Secret（敏感，三值互异，docs/05/09）────────────────────────────
      TELEGRAM_BOT_TOKEN: string;
      TELEGRAM_WEBHOOK_SECRET: string;
      ADMIN_SETUP_SECRET: string;
      // ── 配置（非敏感）───────────────────────────────────────────────
      /** 私有支持群 chat_id（-100 开头负数） */
      SUPPORT_CHAT_ID: string;
      /** 管理员白名单 user_id，逗号分隔 */
      ADMIN_IDS: string;
      /** 未知用户首条消息是否开放建户（docs/09），缺省 true */
      ALLOW_UNKNOWN_USERS: string;
      /** inbox 处理尝试上限（docs/03），缺省 8 */
      MAX_ATTEMPTS: string;
    }
  }
}

export {};
