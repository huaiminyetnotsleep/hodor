-- 原生 Turnstile 人机验证（任务 10-09-turnstile-verification）：users 表增四列
-- 字段与语义唯一事实源：docs/guide/database.md
-- 全局约定：所有表带 bot_id 维度；时间戳 ISO-8601 UTC 文本；布尔用 0/1 整数；不建外键
-- 幂等由 wrangler migrations 台账保证：不写 IF NOT EXISTS，不写任何 DROP / 破坏性语句
-- 四列全部可空：存量行的旧 pending（缺新栅栏）升级后安全失效，由下次消息重出，
-- 不要求已验证用户重验；is_verified / verified_at 不受影响。

-- 当前挑战的请求身份摘要（SHA-256 十六进制，64 小写字符）：三模式共用栅栏。
-- 挑战发出时写入，验证通过 / 撤销 / 封禁 / 全局清题 / 模式或开关变化时清空。
ALTER TABLE users ADD COLUMN verify_request_hash TEXT;

-- 当前请求的到期时间（ISO-8601 UTC 文本）：Turnstile 模式为创建 + 600 秒；
-- math / button 模式不新增题目超时，保持 NULL（无超时语义）。
ALTER TABLE users ADD COLUMN verify_request_expires_at TEXT;

-- 创建当前挑战时的实例验证配置版本（settings.verify_generation 快照）：
-- 模式 / 开关真变化会推进版本并清空全部 pending，使旧挑战（含网页请求）失效。
ALTER TABLE users ADD COLUMN verify_request_generation INTEGER;

-- Turnstile 网页提交的下一许可时间（ISO-8601 UTC 文本）：单条条件 UPDATE 原子
-- 认领 15 秒提交节流窗口，跨 isolate 防重复请求打上游；新请求、通过、撤销、
-- 封禁与模式 / 开关变化时清空（旧失败不误清新请求、不提前结束冷却）。
ALTER TABLE users ADD COLUMN verify_submit_not_before TEXT;
