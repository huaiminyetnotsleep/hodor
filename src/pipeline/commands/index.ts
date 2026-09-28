// pipeline.commands · 管理命令（S6：/ban /unban，S7：/risk /unrisk，S8：/purge /deluser，docs/04）
// 实现挂载点在 src/domain/handlers.ts 注册表 command 槽位；此处提供统一出口（测试复用）。
export * from './handler';
export * from './registry';
export * from './ban';
export * from './risk';
export * from './danger';
