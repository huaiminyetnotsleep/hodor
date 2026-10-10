# 规划（未实现）

本目录只维护**明确标注的未来规划**；当前行为以[功能介绍](/guide/features.md)为准，已发布版本的版本历史以仓库 `CHANGELOG.md` 为准。

## 自托管部署（P3，未排期）

同一代码库同时支持 Cloudflare Workers 与 VPS Docker 两种部署形态；Cloudflare 部署路径保留不动。当前仅立项，启动时间另定；可行性评估结论与阶段明细见 [P3 自托管](/todo/p3.md)。

- [ ] **T59** 可移植类型 HodorEnv / HodorDB，共享层与 Workers 运行时解耦，行为零变化。
- [ ] **T60** 共享路由 route() 抽取，Workers 与 Node 入口共用分发逻辑。
- [ ] **T61** node:sqlite D1 形状适配器与迁移 runner，PRAGMA user_version 跟踪。
- [ ] **T62** Node HTTP 入口与 process.env 装配，HODOR_DB_PATH / RUN_MODE / PORT 运行时变量。
- [ ] **T63** getUpdates 长轮询模式，与 webhook 互斥，复用幂等状态机，免域名免 TLS。
- [ ] **T64** Docker 交付：多阶段 Dockerfile、非 root、数据卷持久化、HEALTHCHECK、compose + env 示例。
- [ ] **T65** 部署文档：deploy-docker 指南与 README 双部署入口，从零 VPS 验收。

## 阶段规划

| 阶段 | 最小交付目标 | 条目 | 依赖 | 明细 |
| --- | --- | --- | --- | --- |
| 阶段 13 双运行时可移植核心 | 共享层类型收窄与路由抽取，行为零变化 | T59–T60 | 阶段 7 稳定基线（推荐） | [阶段 13](/todo/p3.md#stage-13) |
| 阶段 14 VPS Docker 自托管 | Node 24 + node:sqlite 第二运行时、长轮询与容器交付 | T61–T65 | 阶段 13 | [阶段 14](/todo/p3.md#stage-14) |

## 原则

- 规划项必须显式标注为规划；已交付能力一律以 [功能介绍](/guide/features.md)、[部署流程](/guide/deploy.md)与[原理与架构](/guide/architecture.md)为准，不在此复述。
- 每项待办连同相关测试和必要文档一起完成；真实 Telegram 环境验收聊天与部署闭环。
