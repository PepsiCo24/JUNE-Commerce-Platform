-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SessionScope" AS ENUM ('SITE', 'ADMIN');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'HIDDEN', 'DELETED');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'DELETED');

-- CreateEnum
CREATE TYPE "ShopType" AS ENUM ('MAIN', 'SUB');

-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'OFF_SHELF', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'VALIDATING', 'RUNNING', 'PARTIAL', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('POST_IMAGE', 'PRODUCT_IMAGE', 'SHOP_IMAGE', 'AVATAR', 'REFERENCE_IMAGE', 'GENERATED_IMAGE', 'IMPORT_FILE');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('PENDING', 'ACTIVE', 'ORPHAN', 'RECYCLED', 'PURGED');

-- CreateEnum
CREATE TYPE "AssetVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('OPENAI', 'GEMINI', 'ARK_SEEDREAM', 'ALIYUN_WANX', 'BFL_FLUX', 'OPENAI_COMPATIBLE', 'MOCK');

-- CreateEnum
CREATE TYPE "ModelCapability" AS ENUM ('TEXT_TO_IMAGE', 'IMAGE_EDIT', 'TEXT');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('IMAGE_GENERATE', 'IMAGE_EDIT', 'TEXT_COPY');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'PARTIAL', 'SUCCEEDED', 'FAILED', 'CANCELED', 'TIMEOUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ContentRuleType" AS ENUM ('SYSTEM_PROMPT', 'BANNED_WORD', 'BANNED_PHRASE', 'BANNED_CATEGORY', 'PLATFORM_RULE');

-- CreateEnum
CREATE TYPE "RuleAction" AS ENUM ('BLOCK', 'REWRITE', 'WARN');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarKey" TEXT,
    "bio" VARCHAR(500),
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "sessionEpoch" INTEGER NOT NULL DEFAULT 0,
    "passwordChangedAt" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "lastActiveAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "level" INTEGER NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "SessionScope" NOT NULL DEFAULT 'SITE',
    "tokenHash" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "userAgent" VARCHAR(400),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reauth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "reauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "title" VARCHAR(200) NOT NULL,
    "contentHtml" TEXT NOT NULL,
    "contentJson" JSONB,
    "excerpt" VARCHAR(300),
    "coverAssetId" TEXT,
    "imageAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "pinnedOrder" INTEGER,
    "pinnedAt" TIMESTAMPTZ(3),
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "hotScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMPTZ(3),
    "contentEditedAt" TIMESTAMPTZ(3),
    "draftRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "hiddenAt" TIMESTAMPTZ(3),
    "hiddenReason" TEXT,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "content" VARCHAR(2000) NOT NULL,
    "status" "CommentStatus" NOT NULL DEFAULT 'VISIBLE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "hiddenAt" TIMESTAMPTZ(3),
    "hiddenReason" TEXT,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "likes" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" "ShopType" NOT NULL DEFAULT 'MAIN',
    "status" "ShopStatus" NOT NULL DEFAULT 'ACTIVE',
    "name" VARCHAR(120) NOT NULL,
    "platform" VARCHAR(60),
    "url" VARCHAR(500),
    "description" VARCHAR(1000),
    "contactName" VARCHAR(80),
    "contactInfo" VARCHAR(200),
    "note" VARCHAR(1000),
    "parentId" TEXT,
    "overriddenFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_credentials" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "purpose" VARCHAR(120) NOT NULL,
    "account" VARCHAR(200) NOT NULL,
    "loginUrl" VARCHAR(500),
    "note" VARCHAR(1000),
    "passwordCipher" TEXT NOT NULL,
    "passwordIv" TEXT NOT NULL,
    "passwordTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "passwordUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "shop_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "name" VARCHAR(200) NOT NULL,
    "sku" VARCHAR(80),
    "title" VARCHAR(300),
    "description" TEXT,
    "price" DECIMAL(12,2),
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "coverAssetId" TEXT,
    "imageAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "shopId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'product_csv',
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "fileAssetId" TEXT,
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "successRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "rowErrors" JSONB NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'PENDING',
    "visibility" "AssetVisibility" NOT NULL DEFAULT 'PRIVATE',
    "objectKey" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "mimeType" VARCHAR(120) NOT NULL,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT,
    "originalName" VARCHAR(300),
    "derivatives" JSONB NOT NULL DEFAULT '{}',
    "derivativeStatus" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "refCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "recycledAt" TIMESTAMPTZ(3),
    "purgedAt" TIMESTAMPTZ(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_usage" (
    "userId" TEXT NOT NULL,
    "bytesUsed" BIGINT NOT NULL DEFAULT 0,
    "quotaBytes" BIGINT NOT NULL,
    "assetCount" INTEGER NOT NULL DEFAULT 0,
    "recycledBytes" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "storage_usage_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "baseUrl" VARCHAR(500) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "apiKeyCipher" TEXT,
    "apiKeyIv" TEXT,
    "apiKeyTag" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "apiKeyMasked" VARCHAR(64),
    "hasCredential" BOOLEAN NOT NULL DEFAULT false,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 0,
    "lastTestedAt" TIMESTAMPTZ(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_configs" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "modelKey" VARCHAR(200) NOT NULL,
    "capabilities" "ModelCapability"[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "defaultParams" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "model_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "modelConfigId" TEXT,
    "providerSlug" VARCHAR(80),
    "modelKey" VARCHAR(200),
    "modelDisplayName" VARCHAR(120),
    "configVersion" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "referenceAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "referenceCount" INTEGER NOT NULL DEFAULT 0,
    "requestedCount" INTEGER NOT NULL DEFAULT 1,
    "succeededCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "providerTaskIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "providerCallCount" INTEGER NOT NULL DEFAULT 0,
    "stage" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "progressPercent" INTEGER,
    "errorCode" VARCHAR(80),
    "errorMessage" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "queuePriority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "upstreamDurationMs" INTEGER,
    "queueWaitMs" INTEGER,

    CONSTRAINT "generation_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_results" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" "ResultStatus" NOT NULL DEFAULT 'PENDING',
    "assetId" TEXT,
    "textPayload" JSONB,
    "providerTaskId" VARCHAR(200),
    "providerRefUrl" VARCHAR(1000),
    "checkResult" JSONB,
    "errorCode" VARCHAR(80),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "generation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_rules" (
    "id" TEXT NOT NULL,
    "type" "ContentRuleType" NOT NULL,
    "action" "RuleAction" NOT NULL DEFAULT 'BLOCK',
    "name" VARCHAR(160) NOT NULL,
    "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payload" JSONB NOT NULL,
    "applyToInput" BOOLEAN NOT NULL DEFAULT true,
    "applyToOutput" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "content_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_rule_versions" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" TEXT,
    "changeNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_configs" (
    "key" TEXT NOT NULL,
    "value" JSONB,
    "valueCipher" TEXT,
    "valueIv" TEXT,
    "valueTag" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "group" VARCHAR(40) NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "system_configs_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "config_revisions" (
    "scope" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "config_revisions_pkey" PRIMARY KEY ("scope")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" VARCHAR(200),
    "actorRole" VARCHAR(40),
    "action" VARCHAR(80) NOT NULL,
    "targetType" VARCHAR(60) NOT NULL,
    "targetId" VARCHAR(80),
    "diff" JSONB,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" VARCHAR(400),
    "result" VARCHAR(20) NOT NULL DEFAULT 'success',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleanup_runs" (
    "id" TEXT NOT NULL,
    "kind" VARCHAR(60) NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "affected" INTEGER NOT NULL DEFAULT 0,
    "freedBytes" BIGINT NOT NULL DEFAULT 0,
    "sample" JSONB NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "triggeredBy" TEXT,

    CONSTRAINT "cleanup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_createdAt_idx" ON "users"("status", "createdAt");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE INDEX "users_lastActiveAt_idx" ON "users"("lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "roles_slug_key" ON "roles"("slug");

-- CreateIndex
CREATE INDEX "roles_level_idx" ON "roles"("level");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_scope_idx" ON "sessions"("userId", "scope");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "reauth_tokens_tokenHash_key" ON "reauth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "reauth_tokens_userId_purpose_idx" ON "reauth_tokens"("userId", "purpose");

-- CreateIndex
CREATE INDEX "reauth_tokens_expiresAt_idx" ON "reauth_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "posts_slug_key" ON "posts"("slug");

-- CreateIndex
CREATE INDEX "posts_status_isPinned_pinnedOrder_publishedAt_idx" ON "posts"("status", "isPinned", "pinnedOrder", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "posts_status_publishedAt_idx" ON "posts"("status", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "posts_status_hotScore_publishedAt_idx" ON "posts"("status", "hotScore" DESC, "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "posts_authorId_status_updatedAt_idx" ON "posts"("authorId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "posts_createdAt_idx" ON "posts"("createdAt");

-- CreateIndex
CREATE INDEX "comments_postId_status_createdAt_idx" ON "comments"("postId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "comments_authorId_createdAt_idx" ON "comments"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_parentId_idx" ON "comments"("parentId");

-- CreateIndex
CREATE INDEX "likes_userId_createdAt_idx" ON "likes"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "likes_postId_userId_key" ON "likes"("postId", "userId");

-- CreateIndex
CREATE INDEX "shops_ownerId_type_deletedAt_idx" ON "shops"("ownerId", "type", "deletedAt");

-- CreateIndex
CREATE INDEX "shops_ownerId_name_idx" ON "shops"("ownerId", "name");

-- CreateIndex
CREATE INDEX "shops_parentId_idx" ON "shops"("parentId");

-- CreateIndex
CREATE INDEX "shop_credentials_shopId_deletedAt_idx" ON "shop_credentials"("shopId", "deletedAt");

-- CreateIndex
CREATE INDEX "shop_credentials_ownerId_idx" ON "shop_credentials"("ownerId");

-- CreateIndex
CREATE INDEX "shop_credentials_shopId_purpose_idx" ON "shop_credentials"("shopId", "purpose");

-- CreateIndex
CREATE INDEX "products_ownerId_deletedAt_updatedAt_idx" ON "products"("ownerId", "deletedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "products_shopId_status_updatedAt_idx" ON "products"("shopId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "products_ownerId_name_idx" ON "products"("ownerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_shopId_sku_key" ON "products"("shopId", "sku");

-- CreateIndex
CREATE INDEX "import_jobs_ownerId_createdAt_idx" ON "import_jobs"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "import_jobs_status_idx" ON "import_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "assets_objectKey_key" ON "assets"("objectKey");

-- CreateIndex
CREATE INDEX "assets_ownerId_kind_status_idx" ON "assets"("ownerId", "kind", "status");

-- CreateIndex
CREATE INDEX "assets_status_createdAt_idx" ON "assets"("status", "createdAt");

-- CreateIndex
CREATE INDEX "assets_status_recycledAt_idx" ON "assets"("status", "recycledAt");

-- CreateIndex
CREATE UNIQUE INDEX "assets_ownerId_sha256_kind_key" ON "assets"("ownerId", "sha256", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "model_providers_slug_key" ON "model_providers"("slug");

-- CreateIndex
CREATE INDEX "model_providers_enabled_sortOrder_idx" ON "model_providers"("enabled", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "model_configs_slug_key" ON "model_configs"("slug");

-- CreateIndex
CREATE INDEX "model_configs_enabled_visible_sortOrder_idx" ON "model_configs"("enabled", "visible", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "model_configs_providerId_modelKey_key" ON "model_configs"("providerId", "modelKey");

-- CreateIndex
CREATE INDEX "generation_tasks_userId_type_createdAt_idx" ON "generation_tasks"("userId", "type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "generation_tasks_status_createdAt_idx" ON "generation_tasks"("status", "createdAt");

-- CreateIndex
CREATE INDEX "generation_tasks_type_status_createdAt_idx" ON "generation_tasks"("type", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "generation_tasks_userId_idempotencyKey_key" ON "generation_tasks"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "generation_results_taskId_status_idx" ON "generation_results"("taskId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "generation_results_taskId_seq_key" ON "generation_results"("taskId", "seq");

-- CreateIndex
CREATE INDEX "content_rules_type_enabled_sortOrder_idx" ON "content_rules"("type", "enabled", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "content_rule_versions_ruleId_version_key" ON "content_rule_versions"("ruleId", "version");

-- CreateIndex
CREATE INDEX "system_configs_group_idx" ON "system_configs"("group");

-- CreateIndex
CREATE INDEX "system_configs_isPublic_idx" ON "system_configs"("isPublic");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "cleanup_runs_kind_startedAt_idx" ON "cleanup_runs"("kind", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reauth_tokens" ADD CONSTRAINT "reauth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_coverAssetId_fkey" FOREIGN KEY ("coverAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "likes" ADD CONSTRAINT "likes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "likes" ADD CONSTRAINT "likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_credentials" ADD CONSTRAINT "shop_credentials_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_coverAssetId_fkey" FOREIGN KEY ("coverAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_usage" ADD CONSTRAINT "storage_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "model_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_modelConfigId_fkey" FOREIGN KEY ("modelConfigId") REFERENCES "model_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_results" ADD CONSTRAINT "generation_results_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "generation_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_results" ADD CONSTRAINT "generation_results_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_rule_versions" ADD CONSTRAINT "content_rule_versions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "content_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
