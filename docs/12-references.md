# 12 · 参考资源

> **hodor 设计文档 · 12/13**
> 上一篇:[11-roadmap](11-roadmap.md) · 下一篇:[13-implementation-steps](13-implementation-steps.md) · [返回总览](README.md)

---

## 开源参考项目

- TopicDesk:https://github.com/googolgl/topicdesk
- ForumDesk:https://github.com/paipaiio/telegram-customer-service-bot
- tg-pm-support-bot:https://github.com/miss82824352235/tg-pm-support-bot
- telegram-support-bot:https://github.com/apkuzmin/telegram-support-bot

## Telegram Bot API

- setWebhook(含 `secret_token`、`allowed_updates`):https://core.telegram.org/bots/api#setwebhook
- getWebhookInfo:https://core.telegram.org/bots/api#getwebhookinfo
- deleteWebhook:https://core.telegram.org/bots/api#deletewebhook
- getMe:https://core.telegram.org/bots/api#getme
- getUpdates(前置准备取 ID 用;绑 Webhook 后调用返回 409):https://core.telegram.org/bots/api#getupdates
- copyMessage:https://core.telegram.org/bots/api#copymessage
- setMyCommands(命令菜单,含 BotCommandScopeChat 群级 scope):https://core.telegram.org/bots/api#setmycommands
- createForumTopic:https://core.telegram.org/bots/api#createforumtopic
- editForumTopic:https://core.telegram.org/bots/api#editforumtopic
- closeForumTopic:https://core.telegram.org/bots/api#closeforumtopic
- reopenForumTopic:https://core.telegram.org/bots/api#reopenforumtopic
- deleteForumTopic:https://core.telegram.org/bots/api#deleteforumtopic
- getChatMember:https://core.telegram.org/bots/api#getchatmember
- Update 与 update_id 语义:https://core.telegram.org/bots/api#update
- Message 对象(内容字段全集):https://core.telegram.org/bots/api#message
- 错误与限流(flood control / retry_after):https://core.telegram.org/bots/api#responseparameters

> 注意:Bot API **没有**「列举 Forum Topic」的接口——这是 02/08 中崩溃窗口无法自动对账的根因。

## Cloudflare 官方文档

- Workers Limits:https://developers.cloudflare.com/workers/platform/limits/
- Worker Secrets(加密环境变量):https://developers.cloudflare.com/workers/configuration/secrets/
- Worker Versions 与灰度:https://developers.cloudflare.com/workers/configuration/versions-and-deployments/
- Workers Builds(push 自动构建部署,构建/部署命令配置):https://developers.cloudflare.com/workers/ci-cd/builds/
- Deploy to Cloudflare 按钮(自动置备资源、Secret 流程、已知迁移缺口):https://developers.cloudflare.com/workers/platform/deploy-buttons/
- D1 Limits:https://developers.cloudflare.com/d1/platform/limits/
- D1 Migrations:https://developers.cloudflare.com/d1/reference/migrations/
- D1 Wrangler 命令(execute / export 等):https://developers.cloudflare.com/d1/wrangler-commands/
- D1 Time Travel:https://developers.cloudflare.com/d1/time-travel/
- KV Limits:https://developers.cloudflare.com/kv/platform/limits/
- Queues Limits:https://developers.cloudflare.com/queues/platform/limits/
- Durable Objects Limits:https://developers.cloudflare.com/durable-objects/platform/limits/
- R2 Limits:https://developers.cloudflare.com/r2/platform/limits/

## 文档约定

- 版本与修订记录见 [总览](README.md);
- 各篇状态值、表名、术语以 [06 · 数据模型](06-data-model.md) 的字典为准;
- 修改设计时同步更新受影响篇章的互链与导航。
