# 规划（未实现）

本目录只维护**明确标注的未来规划**；当前行为以[功能介绍](/guide/features.md)为准，已发布版本的版本历史以仓库 `CHANGELOG.md` 为准。

## 自托管部署（P3，未排期）

当前正式部署为 Cloudflare Workers + D1；VPS Node / SQLite / Docker 尚未实现、未排期。规划保留 Cloudflare 路径，增加可复用已有服务器、控制运行环境与数据文件的自托管选择，同时由用户承担主机维护与备份责任。

平台取舍、长轮询边界与场景建议见 [P3 部署选型](/todo/p3.md#deployment-choice)；可行性评估与阶段明细见 [P3 自托管](/todo/p3.md)。VPS 操作指南须待实现与验收后发布。

- [ ] **T59** 可移植类型 HodorEnv / HodorDB，共享层与 Workers 运行时解耦，行为零变化。
- [ ] **T60** 共享路由 route() 抽取，Workers 与 Node 入口共用分发逻辑。
- [ ] **T61** node:sqlite D1 形状适配器与迁移 runner，PRAGMA user_version 跟踪。
- [ ] **T62** Node HTTP 入口与 process.env 装配，HODOR_DB_PATH / RUN_MODE / PORT 运行时变量。
- [ ] **T63** getUpdates 长轮询模式：单实例、出站 Telegram 可达，与 webhook 互斥；同 Token 切换前停用旧部署，复用幂等状态机；仅更新接入免域名、免入站 TLS。
- [ ] **T64** Docker 交付：多阶段 Dockerfile、非 root、数据卷持久化、HEALTHCHECK、compose + env 示例。
- [ ] **T65** 用户选型与部署文档：VPS 交付时同步 deploy.md 统一选型入口、deploy-docker 指南、README 双入口、架构及受影响的配置 / 功能 / 运维说明；互链与构建通过，从零 VPS 验收。

## 阶段规划

| 阶段 | 最小交付目标 | 条目 | 依赖 | 明细 |
| --- | --- | --- | --- | --- |
| 阶段 13 双运行时可移植核心 | 共享层类型收窄与路由抽取，行为零变化 | T59–T60 | 阶段 7 稳定基线（推荐） | [阶段 13](/todo/p3.md#stage-13) |
| 阶段 14 VPS Docker 自托管 | Node 24 + node:sqlite 第二运行时、长轮询与容器交付 | T61–T65 | 阶段 13 | [阶段 14](/todo/p3.md#stage-14) |

## 原则

- 规划项必须显式标注为规划；已交付能力一律以 [功能介绍](/guide/features.md)、[部署流程](/guide/deploy.md)与[原理与架构](/guide/architecture.md)为准，不在此复述。
- 每项待办连同相关测试和必要文档一起完成；真实 Telegram 环境验收聊天与部署闭环。
