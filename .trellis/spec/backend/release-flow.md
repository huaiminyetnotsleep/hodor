# 发布流程与 PR 合并约定

> Release Please 自动发版的输入契约。2026-10-09 随 release-please-merge 任务确立。
> 对外流程说明的唯一事实源是 `docs/guide/release.md`；本文件约束 AI 与维护者的仓库操作。

---

## 场景：向 main 合并 PR / 修改发布工作流

### 1. 范围 / 触发

- 创建或合并任何进入 `main` 的 PR
- 撰写将进入 main 历史的提交标题
- 修改 `.github/workflows/release-please.yml` 或 Release PR（`release-please--branches--*` 分支）

### 2. 契约

- 普通 PR **只允许 Squash and merge**（仓库级设置，由管理员在 GitHub Settings → General → Pull Requests 配置）。Squash commit title = PR 标题。
- PR 标题必须为 Conventional Commit：`feat:` → MINOR、`fix:` → PATCH、`BREAKING CHANGE` → MAJOR。Release Please 只解析 main 上的 squash 提交，版本级别由它决定。
- **绝不**向 main 推送标题或正文携带 `feat:` / `fix:` 的 merge commit——同一变更会以原提交 + merge commit 两条进入 CHANGELOG。实证：PR #10（v1.8.0 重复条目）；上游 googleapis/release-please#2476 维护者标注 not planned，官方推荐 squash merge。
- 修正 Release PR 分支（如 `release-please--branches--main--components--hodor`）上的内容，只用**普通新增提交**；绝不 amend、force-push，绝不重写已发布 tag/release。
- GitHub merge 设置是仓库元数据，不在源码文件中；无 `gh` 授权时不得尝试 API 修改，文档只写管理员手动步骤。

### 3. 校验与错误矩阵

| 行为 | 后果 |
|---|---|
| PR 以 merge commit 合并，正文含 Conventional 标题 | CHANGELOG 同一变更出现两条（v1.8.0 实证） |
| PR 标题非 Conventional | 该变更不触发版本 bump，Release PR 不更新 |
| amend / force-push Release PR 分支 | 破坏 action 台账，后续自动更新可能丢失或覆盖人工修正 |
| Release PR 合并后才发现重复条目 | 已随 GitHub Release 发布；只能接受，不改已发布历史 |

### 4. 必需测试

- 无自动化测试覆盖 GitHub 设置与发版行为；以 `test/release-regression.test.ts` 版本一致性断言 + `docs/guide/release.md` 发版前后清单人工核对为准。
- 改动 release.md / PR 模板后运行 `npm run docs:build`（Node 24）与 `git diff --check`。

### 5. Wrong vs Correct

#### Wrong

PR 内含 `feat: xxx` 提交，再以正文带同标题的 merge commit 合并 → CHANGELOG 重复两条。

#### Correct

PR 标题写 `feat: xxx`，Squash and merge → main 仅一条 `feat: xxx`，CHANGELOG 一条。
