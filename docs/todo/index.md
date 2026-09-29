# 全量 TODO

全部待办的完整清单，与分页一一对应：[P1](/todo/p1.md) · [P2](/todo/p2.md)。各步骤交付的功能说明见对应分页的里程碑注释。

## P1 — v1 主线

### M0 工程骨架

- [ ] TypeScript + wrangler 工程（无运行时依赖，原生 fetch）
- [ ] wrangler 配置：D1 绑定、keep_vars
- [ ] 六张表 schema 迁移（见[数据表](/guide/database.md)）
- [ ] Git 集成构建：自动创建 D1 数据库并完成绑定（变量名 `HODOR_DB`，需验证构建令牌的 D1 权限）
- [ ] 部署时自动执行数据库迁移
- [ ] vitest + vitest-pool-workers 测试基座

### M1 Webhook 入口

- [ ] `POST /webhook` 路由与 secret 头校验
- [ ] processed_updates 幂等去重
- [ ] 失败非 200 重推 + MAX_ATTEMPTS 防毒丸

### M2 入站链路（用户 → topic）

- [ ] 用户建档（首条消息即开始，欢迎语 + 验证码，`/start` 频控，文案集中单一模块）
- [ ] topic 确保与创建（名称 = 用户昵称）+ 用户信息置顶
- [ ] copyMessage 全类型直传 + messages 落库

### M3 出站链路（topic → 用户）

- [ ] 管理员判定（ADMIN_IDS，非管理员静默忽略）
- [ ] thread_id 反查路由 + 僵尸 topic 提示
- [ ] copyMessage 私聊送达 + 落库

### M4 人机验证与限频

- [ ] 数学题验证码（4 答案按钮，正确答案只存库）
- [ ] 纯按钮模式 + `/verifymode` 切换（settings 表）
- [ ] 四种重验触发：首条 / deluser 后 / 超限 / TTL 过期
- [ ] VERIFY_TTL_HOURS 有效期
- [ ] 60 秒固定窗口限频 + 超限重验（提示文案带限制数字）
- [ ] 提示回复限频（每用户每分钟 1 次）

### M5 命令全集

- [ ] `/help`（按验证状态动态展示）
- [ ] `/ban` `/unban`
- [ ] `/risk` `/unrisk`（置顶标注 + 24 小时一次性提示）
- [ ] `/purgemsg`（清空 topic + 重置置顶）
- [ ] `/wipealldata`（一键清空全部数据，两步危险确认）
- [ ] `/deluser`（关 topic 留历史 + 重新 start 复用重开）
- [ ] `/note` `/unnote`（备注写入 / 清除，展示于置顶信息）
- [ ] `/verifyon` `/verifyoff`（存量验证保留）

### M6 管理端点

- [ ] `/setwebhook/<ADMIN_SECRET>`（getMe 回显 bot 身份）
- [ ] `/deletewebhook/<ADMIN_SECRET>`
- [ ] `/health` 部署自检（环境变量 / 数据库 / webhook 绑定），全过返回 ok + 版本号

### M7 收尾

- [ ] 集成测试补全（入站 / 出站 / 验证 / 限频 / 命令 / 幂等 / 端点鉴权全链路用例）
- [ ] scripts/d1-console.sql 运维查询包
- [ ] README 与文档同步

## P2 — v1.1

### 多机器人运行时

- [ ] 按 bot 独立 webhook 路径接入（update 不带 bot 身份，必须按路径区分）
- [ ] 多 bot 的 setwebhook / deletewebhook 管理
- [ ] 同一群组多 bot 共存策略（同用户在不同 bot 下独立 topic）

### 换绑迁移（三场景）

- [ ] 场景一：bot 更换、群组不变——消息与 topic 保留，与新 bot 重新绑定
- [ ] 场景二：bot 不变、群组变更——用户无感知，topic 在新群组重建 / 迁移
- [ ] 场景三：bot 与群组都变——完整数据迁移策略
- [ ] 广播能力：换绑前向全部用户发送「客服已迁移，请添加新 Bot @xxx」

### TGuard 人机验证

- [ ] TGuard API 设置（地址 + 密钥）
- [ ] Telegram Mini App 验证界面接入
- [ ] 验证模式三选一：数学题 / 纯按钮 / TGuard
