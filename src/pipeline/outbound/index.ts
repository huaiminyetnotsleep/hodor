// pipeline.outbound · 出站中继（S5：Topic 回复 → 用户私聊 + 403 处理，docs/02/03）
// 实现挂载点在 src/domain/handlers.ts 注册表 outbound 槽位；此处提供统一出口（测试复用）。
export * from './handler';
