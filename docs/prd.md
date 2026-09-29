## 功能描述
用户通过跟机器人聊天，机器人可以把消息映射到超级群组的每个topic上，相当于每个topic对应一个用户；管理员可以在每个topic中（也就是用户对话中聊天）然后通过机器人映射给对应的用户，实现双向聊天
### 项目亮点，可以吸引用户使用和关注
1. cf免费
2. 自部署，不怕消息泄露
3. 一键部署，0改动代码
4. 分组管理，对话清晰，消息不再堆叠，分不清来自哪个用户，多管理员回复（多账号更方便），可以直接对话，不像传统机器人需要恢复消息来回复用户，
5. 多机器人
6. 机器人可以随时换绑，群组可以随时换绑（用户和消息是否可以同步保存）
7. 验证机制
	1. 支持验证，防止机器人刷消息，消耗cf的额度
	2. 消息频率限制，每分钟消息条数显示，超过限制开启重新验证
	3. 删除用户后需要重新验证
	4. 自动开关是否需要验证，关闭后可以跳过验证机制（推荐开启）
8. 多种命令支持
## 实现原理
## 功能设计
1. `MAX_MESSAGES_PER_MINUTE_ENV`：每分钟消息频率限制，超过限制开启重新验证
2. 广播能力，改 Token 前，先在旧 Bot 里人工发一条“客服已迁移，请添加新 Bot @xxx”——这步只能人工，因为旧 Token 已不在 env。
3. 人机验证   确认收到“你好，欢迎使用私聊机器人！”并触发验证码。欢迎文案可以参考命令中start
	1. 可以加一个命令是否开启和关闭，
	2. 支持三种方式（在 **验证码设置** 中选择）：
		1. **按钮验证** — 点击按钮即可
		2. **数学题验证** — 解答简单算术题 - 支持按钮式验证码验证（简单数学题），防止机器人刷消息。
		3. **TGuard 验证** — 需在 **TGuard API 设置** 中配置 API 地址与密钥，验证界面通过 Telegram Mini App 打开
4. 命令
	1. start之后需要有欢迎语，最好带上项目名称和项目地址；还有使用方式（比如直接对话即可）
	2. 用户第一次对话后，可以在topic中置顶显示 用户的信息，用户名，id, 第一次发起聊天的时间
	3. 每个topic中的消息是隔离的，（每个用户只能看到自己的消息），管理员可以看到所有的对话
	4. 管理员的/help命令，可以在每个topic中触发
	5. ban unban 在每个topic(也就是每个用户中可执行)， 用户会被禁言
	6. risk unrisk 高危名单会，会给管理员提示是高危用户，但是可以正常聊天，也可进行ban和unban
	7. purgemsg 在每个topic中的命令，清理和该用户的所有消息
	8. deluser 在这个topic中需要展示的用户，删除之后用户需要重新发起start,（需要提示用户）
	9. /verifyon   开启人机验证  /verifyoff    关闭人机验证， 两个命令根据不同的状态展示不同的命令
5. 强化功能
	1. 多个bot的能力
6. 改 Token 前，先在旧 Bot 里人工发一条“客服已迁移，请添加新 Bot @xxx”——这步只能人工，因为旧 Token 已不在 env。
## Notes
1. Cloudflare Worker 免费套餐有每日 10 万请求的限制。需求里较大可以考虑升级cf的付费计划
2. D1存储消息
3. R2存储图片，视频，附件，如果用户没有开通R2该怎么处理，D1可以存储吗？或者使用tg自带的？
4. 迁移问题 三种情况
	1. bot更换,  group不变，
		1. 消息和topic要保留，和bot解绑；提示用户切换bot，更换bot，需要广播消息，告诉用户已更换bot, 和提供新的bot
		2. 一个群组可以支持多个bot吗？可以指定哪个bot为旧的，用户和旧的bot聊天的时候，可以提示即将要切换到新的bot
		
	2. bot不变，group变更
		1. 用户应该无感知，但是tg群组端的topic可能实现
		2. 应该不需要广播
	3. bot变，group变，？？？数据问题
## 配置变量
1. TELEGRAM_BOT_TOKEN ， 机器人的token
2. TELEGRAM_WEBHOOK_SECRET, 机器人setwebhook和deletewebhook需要用到
3. SUPPORT_CHAT_ID：超级群组的群组ID, 
4. MAX_ATTEMPTS， 最大重试次数
5. ALLOW_UNKNOWN_USERS，默认可以删除了，当然是用来和陌生人聊天的
6. ADMIN_IDS 管理员ids, 支持有多个管理员
7. MAX_MESSAGES_PER_MINUTE_ENV，每分钟消息频率限制
## 准备工作
1. bot的申请
2. 超级群组的创建，还有获取超级群组chat_id的方法，下面是3种方式
	1. 获取群组 ID（可邀请 [@sc_ui_bot](https://t.me/sc_ui_bot) 发送 `/id`）。
	2. @getidsbot 机器人获取
	3. 1Bot 进群后在群里发一条消息 → 浏览器打开 `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` → 记下群 `chat.id`（-100 开头
3. bot进群并且设置为管理员
## 部署运维相关
1. 绑定机器人setwebhook接口，https://worker-url/public/setwebhook, 机器人token可以从环境变量中取，
	1. 考虑多个机器人场景应该怎么处理
	2. 还有换绑机器人时从环境变量中取的先后顺序
	3. 可以支持https://worker-url/public/setwebhook/<BOT_TOKEN>, 如果没有BOT_TOKEN就从环境变量中拿
2. 解绑机器人deletewebhook接口，https://worker-url/public/deletewebhook, 机器人token可以从环境变量中取，
	1. 考虑多个机器人的场景应该怎么处理
	2. 还有换绑机器人时从环境变量中取的先后顺序，可能会删除更新后新机器人
	3. 可以支持https://worker-url/public/deletewebhook/<BOT_TOKEN>, 如果没有BOT_TOKEN就从环境变量中拿
	4. 改 Token 前，先在旧 Bot 里人工发一条“客服已迁移，请添加新 Bot @xxx”——这步只能人工，因为旧 Token 已不在 env。
3. 查询用户的sql脚本
4. 查询聊天信息的sql脚本
5. 一键清理用户和聊天信息的脚本
6. github版本管理，每次有新版本需要更新version, 怎么触发自动更新
## 开发和部署流程整理，尽量做到用户0改动部署，一键部署
1. 优化开发流程
2. 优化部署流程
3. trellis的spec规范更新
## 文档
1. 使用vitepress
2. 需要主要部分有，首页（功能亮点介绍），功能，部署流程（里面包括准备找工作，cf相关配置等），原理（设计目的和原理，最好有架构图和设计图，流程图, 如何分层设计如何解耦的），运维相关（sethook, deletehook, 常用脚本，如何更新代码重新部署），表合适（有哪些表，表字段等）
## 参考
1. https://github.com/iawooo/ctt
2. https://github.com/SideCloudGroup/BetterForward
3. https://github.com/wozulong/open-wegram-bot