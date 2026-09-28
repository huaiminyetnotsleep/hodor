/**
 * webhook · 入口路由（S3）：POST /telegram/webhook/:webhook_key（docs/05 Worker 路由总览）。
 * 编排顺序即 docs/03「处理顺序总览」①②③：Secret 校验 → 幂等登记 → 来源分类 → 状态机。
 */
export * from './router';
