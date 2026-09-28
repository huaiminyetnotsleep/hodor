/**
 * domain · 统一出口（S3 起）。纯领域逻辑与状态字典，不依赖 IO（docs/01「pipeline 不感知触发方式」）：
 * 来源分类纯函数 + Update 处理器注册表。
 */
export * from './classify';
export * from './handlers';
