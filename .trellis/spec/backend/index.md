# 后端开发规范

> hodor Worker(Cloudflare Workers + D1 + Telegram)的项目专属约定。

---

## 规范索引

| 规范 | 说明 | 状态 |
|------|------|------|
| [环境与配置](./env-config.md) | 环境绑定、`.dev.vars` 单点配置、`Cloudflare.Env` 合并 | 已填写(S1) |
| [错误处理](./error-handling.md) | Telegram 三态结果语言、分类矩阵、消费方规则 | 已填写(S2) |
| [测试基座](./testing.md) | vitest-pool-workers 0.22 + Vitest 4 接线方式、迁移注入 | 已填写(S1) |
| [数据库(D1)](./database.md) | 表结构改动与 `docs/guide/database.md` 的强制同步契约 | 已填写(S1) |
| [全用户广播](./broadcast.md) | General 命令、D1 状态机、Telegram 私聊发送、错误与配额边界 | 已填写(2026-10-09) |
| [发布流程与合并约定](./release-flow.md) | Release Please 输入契约：squash-only、Conventional PR 标题、禁止 Conventional merge commit | 已填写(2026-10-09) |
| [部署管线](./deployment.md) | D1 名 = Worker 名派生契约、置备/迁移/注入不变量与 fail-open 告警 | 已填写(2026-10-09) |
| [观测端点](./observability.md) | `/health` 存活探针与 `/selfcheck` 完整自检的双端点契约、严格校验与容错解析分工 | 已填写(S7) |
| [用户验证](./verification.md) | Turnstile 模式、initData HMAC 官方规则、挑战栅栏 CAS 裁决与测试密钥检测 | 已填写(2026-10-09) |
| [管理命令路由](./commands.md) | General 线程归一化、全局命令放行集合、聊天级菜单作用域限制与运行时执行门 | 已填写(2026-10-10) |
| [文档与开源呈现](./docs.md) | README/docs 职责唯一化、交付状态表述、开源 README 样式与同步契约 | 已填写(S8) |

新约定确立后,在此追加新的规范文件(每个主题一个文件,并从本表链接)。
跨层思维检查清单见 [../guides/index.md](../guides/index.md)。

---

**语言**:所有文档一律使用**中文**撰写。
