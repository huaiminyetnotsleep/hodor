// pipeline.inbound · 入站中继（S4：用户私聊 → Topic，docs/02/03）
// 实现挂载点在 src/domain/handlers.ts 注册表 inbound 槽位；此处提供统一出口（测试/S5 复用）。
export * from './handler';
