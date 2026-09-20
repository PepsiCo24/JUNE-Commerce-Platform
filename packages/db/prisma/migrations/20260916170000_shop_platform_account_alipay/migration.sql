-- 店铺平台账号用户名(与名称独立);旧记录允许为空待补充
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "platformAccount" VARCHAR(200);
CREATE INDEX IF NOT EXISTS "shops_ownerId_platformAccount_idx" ON "shops"("ownerId", "platformAccount");

-- 主要登录账号标记:密码只存凭据表,不在 shops 重复
ALTER TABLE "shop_credentials" ADD COLUMN IF NOT EXISTS "isPrimary" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "shop_credentials_shopId_isPrimary_deletedAt_idx"
  ON "shop_credentials"("shopId", "isPrimary", "deletedAt");

-- 支付宝登录账户(仅登录信息,不含支付能力)
CREATE TABLE IF NOT EXISTS "alipay_accounts" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "phone" VARCHAR(40) NOT NULL,
  "passwordCipher" TEXT NOT NULL,
  "passwordIv" TEXT NOT NULL,
  "passwordTag" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL DEFAULT 1,
  "passwordUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "hasPassword" BOOLEAN NOT NULL DEFAULT true,
  "note" VARCHAR(1000),
  "shopId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "alipay_accounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "alipay_accounts_ownerId_deletedAt_updatedAt_idx"
  ON "alipay_accounts"("ownerId", "deletedAt", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "alipay_accounts_ownerId_name_idx" ON "alipay_accounts"("ownerId", "name");
CREATE INDEX IF NOT EXISTS "alipay_accounts_ownerId_phone_idx" ON "alipay_accounts"("ownerId", "phone");
CREATE INDEX IF NOT EXISTS "alipay_accounts_shopId_idx" ON "alipay_accounts"("shopId");

DO $$ BEGIN
  ALTER TABLE "alipay_accounts"
    ADD CONSTRAINT "alipay_accounts_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "alipay_accounts"
    ADD CONSTRAINT "alipay_accounts_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
