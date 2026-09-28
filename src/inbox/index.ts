/**
 * inbox · 统一出口（S3）。pipeline 只 import 本模块，不直接引用内部文件：
 * 幂等登记 + 状态机（docs/03/08）。
 */
export * from './register';
export * from './process';
