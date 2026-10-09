# 文档与开源呈现规范

> 2026-10-09 文档重整任务确立。约束 README、docs/** 的职责划分、交付状态表述与开源呈现样式。

---

## 场景：新增或修改对外文档（README / docs/**）

### 1. 范围 / 触发

- 改动 `README.md`、`docs/**/*.md`、`docs/.vitepress/config.mts`
- 新功能交付、行为变化、或规划项落地时同步对外描述

### 2. 职责唯一化契约

每个主题只有一个权威位置；其余位置只放链接，不复述流程。

| 位置 | 唯一职责 |
|---|---|
| `README.md` | 开源入口：Why、功能亮点、限制、快速开始、ID 获取方法、关键配置（9 变量精简表 + 管理命令分组表 + 常用命令，2026-10-09 用户决策）、文档导航、贡献、致谢、License。**不**放部署分步、更新回滚、SQL 指引（完整契约仍归 deploy.md / ops.md） |
| `docs/index.md` | 文档站首页与导航，不追踪交付状态 |
| `docs/guide/deploy.md` | 部署与首次使用唯一指南（前置、ID 获取、9 变量权威清单、三条路径、部署后验收） |
| `docs/guide/features.md` | 用户/管理员行为（消息类型、验证频控、命令、生命周期） |
| `docs/guide/ops.md` | Webhook/Token 运维、health vs selfcheck、排障；SQL 全文以 `scripts/d1-console.sql` 为准 |
| `docs/guide/development.md` | 本地开发（根项目 Node 24） |
| `docs/guide/architecture.md` | 模块边界、数据流、设计决策（维护者参考，不复述功能页） |
| `docs/guide/database.md` | Schema 唯一事实源（见 [数据库规范](./database.md)） |
| `docs/guide/release.md` | 发版与 fork 更新流程 |
| `docs/todo/*` | 只放明确标注的未来规划；`CHANGELOG.md` 记录已发布版本 |

### 3. 表述规则

- **已交付 vs 规划分离**：已实现能力不得残留「阶段 N 进行中 / 未来工作」表述；规划项必须显式标注为规划并链接 `docs/todo/`。grep `进行中|当前阶段|未来工作` 应零命中（设计沿革叙述除外）。
- **生命周期措辞**：话题映射是「长期复用」而非「永久绑定」——仅 `/deluser` 或原生删话题后换新。
- **成本措辞**：写「取决于 Cloudflare 套餐与配额」，不承诺「免费」。
- **语言**：一律简体中文（VitePress `zh-CN`），不做平行翻译。
- **Node 版本**：根项目 Node 24（`.nvmrc`）；文档站 CI 独立用 Node 22（`docs-pages.yml`），不得混淆。
- **段落排版**：单段不超过约 120 个中文字符；流程用编号列表、并列用无序列表。README（GitHub 渲染）可段内硬换行；docs/**（VitePress）禁止段中硬换行——软换行会渲染成中文句间空隙，只能空行分段。

### 4. README 开源样式约定

对标 grammY / Uptime Kuma / Memos 的结构：居中标头（标题 + 一句话定位 + 简介）→ 快捷链接行 → 徽章行（CI / License / Node / Cloudflare）→「为什么选择」利益导向段落 → 功能表（能力 + 说明）→ 工作原理（mermaid）→ 关键限制用 GitHub 提示块（`> [!IMPORTANT]`）→ 快速开始（前置条件 + 三条部署路径各用**小节标题 + 具体步骤**（表格与单行列表在此场景杂乱难读；Deploy 按钮用官方按钮图片 `deploy.workers.cloudflare.com/button`）+ `> [!TIP]`）→ 关键配置与命令（9 变量精简表：变量/类型/必填/默认/说明 + 管理命令分组表（描述与 `src/copy.ts` `ADMIN_COMMAND_MENU` 一致）+ 常用命令代码块）→ 文档导航表 → 参与贡献 → 致谢（设计参考与 `architecture.md` 参考项目一致；文档样式参考单列一行）→ License。功能展示图：无真实截图时用自绘 SVG 示意原型（`docs/public/prototype.svg`，绝对定位文字避免等宽对齐问题），README 头部 `<p align="center">` 内嵌。

### 5. 同步契约

功能/行为变更与受影响文档页**同一提交**更新（模式同 [数据库规范](./database.md) 的迁移-文档同步）。对外描述必须有源码或 spec 依据。

### 6. Wrong vs Correct

#### Wrong

新命令只改 `src/copy.ts`：README 功能列表、features 命令表、部署验收步骤全部漂移；README 里保留完整环境变量表，与 deploy.md 各自腐化。

#### Correct

同提交内：源码 + features 命令表（权威）更新；README 只在能力亮点层面同步一句；deploy.md 若涉及验收步骤同步更新。

---

## 相关规范

- [数据库（D1）](./database.md) — schema 文档同步契约（本规范是其文档面的推广）
- [环境与配置](./env-config.md) — 9 变量契约（deploy.md 变量清单的事实源）
- [观测端点](./observability.md) — health/selfcheck 契约（README 与 ops.md 表述的依据）
