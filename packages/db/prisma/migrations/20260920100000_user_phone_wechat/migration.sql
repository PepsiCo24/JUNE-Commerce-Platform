-- 用户资料改为手机号与微信号;保留旧 website 列,支持发布失败时回滚旧代码。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" VARCHAR(20);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wechatId" VARCHAR(64);
