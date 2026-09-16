/**
 * 管理站响应类型。
 *
 * 能用 `@june/shared` 契约的一律直接用(AdminUserSummary / AdminProviderView /
 * AdminModelConfigView / AuditLogView / CleanupRunView / StorageOverview ...);
 * 这里只镜像后端 `apps/api/src/modules/admin/admin.types.ts` 中"管理站内部使用、
 * 未进共享契约"的结构。字段与后端逐一对应,金额与字节一律是字符串。
 */

import type { AdminUserDetail, DashboardMetrics, StorageOverview } from '@june/shared';

export interface TrendPoint {
  date: string;
  value: number;
}

export interface MetricWithDefinition {
  value: number;
  definition: string;
}

export interface BytesMetricWithDefinition {
  value: string;
  definition: string;
}

export type TrendKey = 'newUsers' | 'activeUsers' | 'posts' | 'tasks' | 'successRate' | 'storageBytes';

export interface AdminDashboardView extends DashboardMetrics {
  breakdown: {
    shopsMain: MetricWithDefinition;
    shopsSub: MetricWithDefinition;
    postsPublished: MetricWithDefinition;
    postsDraft: MetricWithDefinition;
    postsHidden: MetricWithDefinition;
    generationSucceeded: MetricWithDefinition;
    generationPartial: MetricWithDefinition;
    generationFailed: MetricWithDefinition;
    generationRateDenominator: MetricWithDefinition;
    storageRecycledBytes: BytesMetricWithDefinition;
  };
  extraTrends: {
    successRate: TrendPoint[];
    storageBytes: TrendPoint[];
  };
  trendDefinitions: Record<TrendKey, string>;
}

export interface DashboardMeta {
  maxRangeDays: number;
  granularities: string[];
  cacheTtlSeconds: number;
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

/** 凭据条目:只有用途/账号/登录地址/备注。后端类型层面就没有密码字段。 */
export interface AdminShopCredentialView {
  id: string;
  purpose: string;
  account: string;
  loginUrl: string | null;
  note: string | null;
}

export interface AdminShopDetailView {
  id: string;
  name: string;
  type: 'MAIN' | 'SUB';
  status: string;
  platform: string | null;
  parentId: string | null;
  parentName: string | null;
  url: string | null;
  contactName: string | null;
  contactInfo: string | null;
  productCount: number;
  childCount: number;
  createdAt: string;
  updatedAt: string;
  credentials: AdminShopCredentialView[];
}

export interface AdminProductSummaryView {
  id: string;
  name: string;
  sku: string | null;
  status: string;
  price: string | null;
  currency: string;
  stock: number;
  imageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserDetailView extends AdminUserDetail {
  activeSessionCount: number;
  totalSessionCount: number;
  storageQuotaBytes: string;
  storageRecycledBytes: string;
  storageUsedPercent: number;
  shopStats: { main: number; sub: number };
  productStats: { total: number; byStatus: Array<{ status: string; count: number }> };
  postStats: { total: number; byStatus: Array<{ status: string; count: number }> };
  passwordChangedAt: string | null;
  sessionEpoch: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 内容(帖子 / 评论)
// ---------------------------------------------------------------------------

/**
 * 与 `apps/api/src/modules/admin/admin-content.service.ts` 的 AdminPostView 对齐。
 * 操作者信息以审计日志为准,本视图不编造 lastAction。
 */
export interface AdminPostView {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  status: string;
  authorId: string;
  authorName: string;
  authorEmail: string;
  isPinned: boolean;
  pinnedOrder: number | null;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  publishedAt: string | null;
  updatedAt: string;
  contentEditedAt: string | null;
  hiddenAt: string | null;
  hiddenReason: string | null;
  deletedAt: string | null;
  contentHtml: string;
}

export interface AdminCommentView {
  id: string;
  postId: string;
  postTitle: string;
  postSlug: string;
  authorId: string;
  authorName: string;
  content: string;
  status: string;
  parentId: string | null;
  createdAt: string;
  hiddenAt: string | null;
  hiddenReason: string | null;
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export interface AdminTaskListItem {
  id: string;
  userId: string;
  userEmail: string | null;
  type: string;
  status: string;
  stage: string;
  providerSlug: string | null;
  modelKey: string | null;
  modelDisplayName: string | null;
  configVersion: number;
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  providerCallCount: number;
  providerTaskIds: string[];
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  attempt: number;
  queueWaitMs: number | null;
  upstreamDurationMs: number | null;
  totalDurationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AdminTaskResultView {
  id: string;
  seq: number;
  status: string;
  assetId: string | null;
  providerTaskId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  hasTextPayload: boolean;
  checkPassed: boolean | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AdminTaskDetailView extends AdminTaskListItem {
  /** 已由后端脱敏:形似密钥/令牌的字段会被替换为 [redacted] */
  params: Record<string, unknown>;
  referenceCount: number;
  results: AdminTaskResultView[];
}

export interface AdminTaskStatsRow {
  providerSlug: string;
  modelKey: string;
  modelDisplayName: string | null;
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  rateDenominator: number;
  successRate: number;
  p95UpstreamMs: number | null;
  p50UpstreamMs: number | null;
  providerCallCount: number;
}

export interface AdminTaskStatsResponse {
  range: { from: string; to: string };
  rows: AdminTaskStatsRow[];
  definitions: { successRate: string; p95: string; providerCallCount: string };
  computedAt: string;
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

export interface AdminStorageOverviewView extends StorageOverview {
  byKind: Array<{ kind: string; bytes: string; assetCount: number }>;
  pendingCleanup: {
    recycledAssetCount: number;
    recycledBytes: string;
    dueAssetCount: number;
    dueBytes: string;
    recycleDays: number;
  };
  quotaExceededUsers: Array<{
    userId: string;
    email: string;
    bytesUsed: string;
    quotaBytes: string;
    overBytes: string;
  }>;
  definitions: {
    totalBytes: string;
    activeBytes: string;
    recycledBytes: string;
    orphanBytes: string;
    topUsers: string;
    growth30d: string;
  };
  computedAt: string;
}

export interface QuotaBounds {
  min: string;
  max: string;
}

// ---------------------------------------------------------------------------
// 系统配置
// ---------------------------------------------------------------------------

export interface AdminSystemConfigView {
  key: string;
  group: string;
  description: string | null;
  isSecret: boolean;
  isPublic: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  /** 非敏感值原样返回;敏感值恒为 null */
  value: unknown;
  /** 敏感值的掩码;非敏感值为 null */
  valueMasked: string | null;
  hasSecret: boolean;
}

// ---------------------------------------------------------------------------
// 内容规则
// ---------------------------------------------------------------------------

export interface ContentRuleVersionView {
  id: string;
  version: number;
  snapshot: Record<string, unknown>;
  changedBy: string | null;
  changeNote: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

export interface ModelDeleteResult {
  deleted: boolean;
  disabled: boolean;
  taskRefCount: number;
  message: string;
}

export interface AuditLogFilterOptions {
  actions: string[];
  targetTypes: string[];
  cachedAt: string;
}
