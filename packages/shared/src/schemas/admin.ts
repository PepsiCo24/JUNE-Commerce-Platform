import { z } from 'zod';

import { TARGET_PLATFORMS } from '../constants';
import { modelLimitsSchema } from '../model-capabilities';
import { cursorQuerySchema, dateRangeSchema, idSchema, pageQuerySchema } from './common';
import { emailSchema, passwordSchema } from './auth';

// ---------------------------------------------------------------------------
// 管理员登录(独立入口)
// ---------------------------------------------------------------------------

export const adminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// 用户管理
// ---------------------------------------------------------------------------

export const adminUserListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['ALL', 'ACTIVE', 'DISABLED']).default('ALL'),
  role: z.enum(['ALL', 'user', 'admin', 'super_admin']).default('ALL'),
  sort: z.enum(['created_desc', 'created_asc', 'active_desc']).default('created_desc'),
});

export const adminUserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'DISABLED']),
  reason: z.string().trim().max(300).optional(),
});

export const adminUserRoleSchema = z.object({
  roles: z.array(z.enum(['user', 'admin', 'super_admin'])).min(1),
});

export const adminCreateAdminSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(40),
  role: z.enum(['admin', 'super_admin']).default('admin'),
});

export interface AdminUserSummary {
  id: string;
  email: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  roles: string[];
  shopCount: number;
  productCount: number;
  postCount: number;
  taskCount: number;
  storageBytes: string;
  createdAt: string;
  lastLoginAt: string | null;
  lastActiveAt: string | null;
}

/** 管理员查看用户的店铺与商品业务数据。默认不含店铺密码。 */
export interface AdminUserDetail extends AdminUserSummary {
  bio: string | null;
  shops: Array<{
    id: string;
    name: string;
    type: 'MAIN' | 'SUB';
    status: string;
    platform: string | null;
    parentId: string | null;
    parentName: string | null;
    productCount: number;
    credentialCount: number;
  }>;
  /**
   * 明确声明:管理员接口不返回用户保存的店铺密码,
   * 该字段固定为 false,仅用于在界面上说明能力边界。
   */
  canViewShopPasswords: false;
}

// ---------------------------------------------------------------------------
// 仪表盘
// ---------------------------------------------------------------------------

export const dashboardQuerySchema = z.intersection(
  dateRangeSchema,
  z.object({
    /** 趋势图粒度 */
    granularity: z.enum(['day', 'week']).default('day'),
  }),
);

export interface DashboardMetrics {
  range: { from: string; to: string; granularity: 'day' | 'week' };
  /** 每项都带口径说明,避免统计歧义 */
  totals: {
    users: { value: number; definition: string };
    newUsers: { value: number; definition: string };
    activeUsers: { value: number; definition: string };
    shops: { value: number; definition: string };
    products: { value: number; definition: string };
    posts: { value: number; definition: string };
    comments: { value: number; definition: string };
    generationTasks: { value: number; definition: string };
    generationSuccessRate: { value: number; definition: string };
    storageBytes: { value: string; definition: string };
  };
  trends: {
    newUsers: Array<{ date: string; value: number }>;
    activeUsers: Array<{ date: string; value: number }>;
    posts: Array<{ date: string; value: number }>;
    tasks: Array<{ date: string; succeeded: number; failed: number; total: number }>;
  };
  /** 统计使用短期缓存,这里明确告知数据时间 */
  computedAt: string;
  cacheTtlSeconds: number;
}

// ---------------------------------------------------------------------------
// 内容管理
// ---------------------------------------------------------------------------

export const adminPostListQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['ALL', 'DRAFT', 'PUBLISHED', 'HIDDEN', 'DELETED']).default('ALL'),
  authorId: idSchema.optional(),
  pinned: z.enum(['ALL', 'PINNED', 'NORMAL']).default('ALL'),
});

export const adminPostUpdateSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  contentHtml: z.string().max(512 * 1024).optional(),
  excerpt: z.string().trim().max(300).nullable().optional(),
  /** 修改原因,写入审计 */
  reason: z.string().trim().max(300).optional(),
});

export const adminPostVisibilitySchema = z.object({
  action: z.enum(['hide', 'restore', 'delete']),
  reason: z.string().trim().max(300).optional(),
});

export const adminPostPinSchema = z.object({
  pinned: z.boolean(),
  /** 置顶自定义顺序,数值越小越靠前 */
  order: z.number().int().min(0).max(9999).optional(),
});

/** 批量调整置顶顺序 */
export const adminPinReorderSchema = z.object({
  items: z.array(z.object({ postId: idSchema, order: z.number().int().min(0).max(9999) })).min(1).max(100),
});

export const adminCommentListQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  postId: idSchema.optional(),
  status: z.enum(['ALL', 'VISIBLE', 'HIDDEN', 'DELETED']).default('ALL'),
});

export const adminCommentActionSchema = z.object({
  action: z.enum(['hide', 'restore', 'delete']),
  reason: z.string().trim().max(300).optional(),
});

// ---------------------------------------------------------------------------
// 模型管理
// ---------------------------------------------------------------------------

export const PROVIDER_KINDS = [
  'OPENAI',
  'GEMINI',
  'ARK_SEEDREAM',
  'ALIYUN_WANX',
  'BFL_FLUX',
  'OPENAI_COMPATIBLE',
  'MOCK',
] as const;

export const providerCreateSchema = z.object({
  slug: z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/, 'slug 只能包含小写字母、数字和连字符'),
  kind: z.enum(PROVIDER_KINDS),
  name: z.string().trim().min(1).max(120),
  /**
   * API 地址。后端会做 SSRF 防护:必须是 http(s),
   * 且默认拒绝解析到内网/回环/链路本地地址的主机。
   */
  baseUrl: z.url('API 地址必须是合法 URL').max(500),
  /** 明文只在写入时提交,存库即加密,任何读接口都不回传 */
  apiKey: z.string().min(1).max(500).optional(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  rateLimitPerMinute: z.number().int().min(0).max(100_000).default(0),
  maxConcurrency: z.number().int().min(0).max(1000).default(0),
});
export type ProviderCreateInput = z.infer<typeof providerCreateSchema>;

export const providerUpdateSchema = providerCreateSchema.partial().omit({ slug: true, kind: true }).extend({
  /** 传空字符串表示清除已保存的密钥 */
  apiKey: z.string().max(500).optional(),
});

export const modelConfigCreateSchema = z.object({
  providerId: idSchema,
  slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/),
  displayName: z.string().trim().min(1).max(120),
  /** 真实模型标识,提交给供应商的值 */
  modelKey: z.string().trim().min(1).max(200),
  capabilities: z.array(z.enum(['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'TEXT'])).min(1),
  enabled: z.boolean().default(true),
  visible: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isDefault: z.boolean().default(false),
  limits: modelLimitsSchema,
  defaultParams: z.record(z.string().max(60), z.unknown()).default({}),
});
export type ModelConfigCreateInput = z.infer<typeof modelConfigCreateSchema>;

export const modelConfigUpdateSchema = modelConfigCreateSchema.partial().omit({ providerId: true });

/** 模型选择策略设置 */
export const modelPolicyUpdateSchema = z.object({
  image: z.object({
    mode: z.enum(['user_selectable', 'fixed']),
    fixedModelId: idSchema.nullable(),
  }),
  text: z.object({
    mode: z.enum(['user_selectable', 'fixed']),
    fixedModelId: idSchema.nullable(),
  }),
});
export type ModelPolicyUpdateInput = z.infer<typeof modelPolicyUpdateSchema>;

/** 管理端返回的供应商信息:密钥只给脱敏值 */
export interface AdminProviderView {
  id: string;
  slug: string;
  kind: (typeof PROVIDER_KINDS)[number];
  name: string;
  baseUrl: string;
  enabled: boolean;
  sortOrder: number;
  /** 如 sk-****3f9a;不回传明文 */
  apiKeyMasked: string | null;
  hasCredential: boolean;
  rateLimitPerMinute: number;
  maxConcurrency: number;
  modelCount: number;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  createdAt: string;
}

export interface AdminModelConfigView {
  id: string;
  providerId: string;
  providerSlug: string;
  providerName: string;
  providerKind: (typeof PROVIDER_KINDS)[number];
  providerHasCredential: boolean;
  slug: string;
  displayName: string;
  modelKey: string;
  capabilities: Array<'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'TEXT'>;
  enabled: boolean;
  visible: boolean;
  sortOrder: number;
  isDefault: boolean;
  limits: z.infer<typeof modelLimitsSchema>;
  defaultParams: Record<string, unknown>;
  /** 被历史任务引用的次数,提示删除风险 */
  taskRefCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderTestResult {
  ok: boolean;
  /** 已脱敏的错误信息 */
  message: string;
  latencyMs: number | null;
  testedAt: string;
}

// ---------------------------------------------------------------------------
// 内容规则管理
// ---------------------------------------------------------------------------

export const contentRuleCreateSchema = z.object({
  type: z.enum(['SYSTEM_PROMPT', 'BANNED_WORD', 'BANNED_PHRASE', 'BANNED_CATEGORY', 'PLATFORM_RULE']),
  action: z.enum(['BLOCK', 'REWRITE', 'WARN']).default('BLOCK'),
  name: z.string().trim().min(1).max(160),
  platforms: z.array(z.enum(TARGET_PLATFORMS.map((p) => p.value) as [string, ...string[]])).default([]),
  /**
   * 载荷结构按 type 区分:
   *  SYSTEM_PROMPT  -> { text: string }
   *  BANNED_WORD    -> { words: string[], caseSensitive?: boolean }
   *  BANNED_PHRASE  -> { patterns: string[](正则), flags?: string }
   *  BANNED_CATEGORY-> { category: string, description: string, keywords: string[] }
   *  PLATFORM_RULE  -> { maxTitleChars?, maxBodyChars?, forbiddenSymbols?: string[], requireKeywords?: string[] }
   */
  payload: z.record(z.string().max(60), z.unknown()),
  applyToInput: z.boolean().default(true),
  applyToOutput: z.boolean().default(true),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  changeNote: z.string().trim().max(300).optional(),
});
export type ContentRuleCreateInput = z.infer<typeof contentRuleCreateSchema>;

export const contentRuleUpdateSchema = contentRuleCreateSchema.partial().omit({ type: true });

export interface AdminContentRuleView {
  id: string;
  type: string;
  action: string;
  name: string;
  platforms: string[];
  payload: Record<string, unknown>;
  applyToInput: boolean;
  applyToOutput: boolean;
  enabled: boolean;
  sortOrder: number;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

// ---------------------------------------------------------------------------
// 分享配置
// ---------------------------------------------------------------------------

export const shareConfigUpdateSchema = z.object({
  /** 分享链接使用的对外域名 */
  publicOrigin: z.url().max(300),
  wechat: z.object({
    enabled: z.boolean().default(false),
    appId: z.string().trim().max(80).default(''),
    /** 明文只在写入时提交,存库即加密 */
    appSecret: z.string().max(200).optional(),
    /** 已在公众号后台配置的 JS 安全域名,用于自检提示 */
    jsApiDomain: z.string().trim().max(200).default(''),
  }),
  qq: z.object({
    enabled: z.boolean().default(false),
    appId: z.string().trim().max(80).default(''),
  }),
});
export type ShareConfigUpdateInput = z.infer<typeof shareConfigUpdateSchema>;

export interface AdminShareConfigView {
  publicOrigin: string;
  wechat: {
    enabled: boolean;
    appId: string;
    appSecretMasked: string | null;
    hasSecret: boolean;
    jsApiDomain: string;
  };
  qq: { enabled: boolean; appId: string };
}

// ---------------------------------------------------------------------------
// 并发与系统配置
// ---------------------------------------------------------------------------

export const concurrencyConfigSchema = z.object({
  imageGlobal: z.number().int().min(1).max(200),
  textGlobal: z.number().int().min(1).max(500),
  imagePerUserRunning: z.number().int().min(1).max(20),
  imagePerUserPending: z.number().int().min(1).max(50),
  imageProcess: z.number().int().min(1).max(16),
  queueMaxDepthImage: z.number().int().min(10).max(100_000),
  queueMaxDepthText: z.number().int().min(10).max(100_000),
});
export type ConcurrencyConfigInput = z.infer<typeof concurrencyConfigSchema>;

// ---------------------------------------------------------------------------
// 审计与运维
// ---------------------------------------------------------------------------

export const auditLogQuerySchema = cursorQuerySchema.extend({
  action: z.string().trim().max(80).optional(),
  actorId: idSchema.optional(),
  targetType: z.string().trim().max(60).optional(),
  targetId: z.string().trim().max(80).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export interface AuditLogView {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  diff: unknown;
  metadata: unknown;
  ip: string | null;
  result: string;
  createdAt: string;
}

export const cleanupRunSchema = z.object({
  kind: z.enum(['orphan_asset', 'expired_upload', 'recycled_asset', 'queue_record']),
  /** 预览模式不做实际删除 */
  dryRun: z.boolean().default(true),
  /** 单次处理上限,便于分批执行 */
  limit: z.number().int().min(1).max(10_000).default(500),
});

export interface CleanupRunView {
  id: string;
  kind: string;
  dryRun: boolean;
  status: string;
  scanned: number;
  matched: number;
  affected: number;
  freedBytes: string;
  sample: unknown[];
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export interface StorageOverview {
  totalBytes: string;
  activeBytes: string;
  recycledBytes: string;
  orphanBytes: string;
  assetCount: number;
  topUsers: Array<{ userId: string; email: string; bytesUsed: string; assetCount: number }>;
  growth30d: Array<{ date: string; bytes: string }>;
}
