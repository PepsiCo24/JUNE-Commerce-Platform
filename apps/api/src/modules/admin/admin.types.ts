/**
 * 管理站内部返回类型。
 *
 * 原则:能用 `@june/shared` 的契约就直接用(DashboardMetrics / AdminUserSummary /
 * StorageOverview / AuditLogView / CleanupRunView ...),这里只补充契约里没有覆盖、
 * 且只在管理站内部使用的结构。**不修改 shared 契约**。
 */
import type {
  AdminUserDetail,
  CursorResult,
  DashboardMetrics,
  StorageOverview,
} from '@june/shared';

/** Recharts 直接消费的点位结构 */
export interface TrendPoint {
  date: string;
  value: number;
}

/**
 * 仪表盘响应。
 *
 * 契约 `DashboardMetrics` 的 totals 只给了单值 + 口径,trends 只有 4 条曲线;
 * 需求还要求"店铺主/子拆分""帖子按状态拆分""成功率与存储增长趋势",
 * 因此这里在契约之外**追加**字段(而不是改契约结构),前端可按需读取。
 */
export interface AdminDashboardView extends DashboardMetrics {
  /** 契约 totals 的进一步拆分,每项同样带口径说明 */
  breakdown: {
    shopsMain: { value: number; definition: string };
    shopsSub: { value: number; definition: string };
    postsPublished: { value: number; definition: string };
    postsDraft: { value: number; definition: string };
    postsHidden: { value: number; definition: string };
    generationSucceeded: { value: number; definition: string };
    generationPartial: { value: number; definition: string };
    generationFailed: { value: number; definition: string };
    /** 成功率分母(SUCCEEDED + PARTIAL + FAILED),便于前端展示"n 个可判定任务" */
    generationRateDenominator: { value: number; definition: string };
    storageRecycledBytes: { value: string; definition: string };
  };
  /** 契约 trends 之外的两条曲线 */
  extraTrends: {
    /** 每桶成功率(0~100,保留一位小数),分母口径与 totals 一致 */
    successRate: TrendPoint[];
    /** 每桶新增存储字节数(number 会超出安全整数的量级在本平台不会出现) */
    storageBytes: TrendPoint[];
  };
  /** 每条趋势曲线的口径说明,前端图表下方直接展示 */
  trendDefinitions: Record<
    'newUsers' | 'activeUsers' | 'posts' | 'tasks' | 'successRate' | 'storageBytes',
    string
  >;
}

// ---------------------------------------------------------------------------
// 用户管理
// ---------------------------------------------------------------------------

/**
 * 管理站看到的店铺凭据。
 *
 * **这里故意没有 password / passwordCipher / passwordIv / passwordTag / keyVersion 字段。**
 * 管理员既不能拿到明文,也不能拿到密文——类型层面就不给这些字段留位置,
 * 避免后续有人"顺手"把密文塞进响应。
 */
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
  /** 凭据条目:只有用途/账号/登录地址/备注,永不含密码 */
  credentials: AdminShopCredentialView[];
}

export interface AdminProductSummaryView {
  id: string;
  name: string;
  sku: string | null;
  status: string;
  /** Decimal 一律以字符串返回,禁止转 number */
  price: string | null;
  currency: string;
  stock: number;
  imageCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 用户详情。契约 `AdminUserDetail` 已固定了资料/角色/店铺列表的结构,
 * 这里补充需求要求的"会话数、存储配额、商品统计"等字段。
 */
export interface AdminUserDetailView extends AdminUserDetail {
  /** 未撤销且未过期的会话数 */
  activeSessionCount: number;
  /** 历史会话记录总数(含已撤销,用于判断登录频次) */
  totalSessionCount: number;
  storageQuotaBytes: string;
  storageRecycledBytes: string;
  /** 已用占配额百分比,保留一位小数 */
  storageUsedPercent: number;
  shopStats: { main: number; sub: number };
  productStats: { total: number; byStatus: Array<{ status: string; count: number }> };
  postStats: { total: number; byStatus: Array<{ status: string; count: number }> };
  passwordChangedAt: string | null;
  sessionEpoch: number;
  updatedAt: string;
}

export type AdminShopListResult = CursorResult<AdminShopDetailView>;
export type AdminProductListResult = CursorResult<AdminProductSummaryView>;

// ---------------------------------------------------------------------------
// 任务记录
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
  /** 提交时的全局模型配置版本号,便于排查"改配置后开始失败" */
  configVersion: number;
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  /** 上游实际调用次数(计费口径) */
  providerCallCount: number;
  providerTaskIds: string[];
  errorCode: string | null;
  /** 已脱敏 */
  errorMessage: string | null;
  retryable: boolean;
  attempt: number;
  queueWaitMs: number | null;
  upstreamDurationMs: number | null;
  /** 端到端耗时:finishedAt - createdAt,未结束为 null */
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
  /** 已脱敏 */
  errorMessage: string | null;
  hasTextPayload: boolean;
  checkPassed: boolean | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AdminTaskDetailView extends AdminTaskListItem {
  /** 已脱敏的生成参数:任何形似密钥/令牌的字段都会被替换为 [redacted] */
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
  /** 成功率分母(succeeded + partial + failed) */
  rateDenominator: number;
  /** 0~100,保留一位小数 */
  successRate: number;
  /** 上游耗时 P95(毫秒),样本不足时为 null */
  p95UpstreamMs: number | null;
  p50UpstreamMs: number | null;
  providerCallCount: number;
}

export interface AdminTaskStatsResponse {
  range: { from: string; to: string };
  rows: AdminTaskStatsRow[];
  definitions: {
    successRate: string;
    p95: string;
    providerCallCount: string;
  };
  computedAt: string;
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

export interface AdminStorageOverviewView extends StorageOverview {
  /** 按资产用途分布 */
  byKind: Array<{ kind: string; bytes: string; assetCount: number }>;
  /** 回收站中等待物理清除的量 */
  pendingCleanup: {
    recycledAssetCount: number;
    recycledBytes: string;
    /** 已过回收期、下一次清理任务会真正删除的部分 */
    dueAssetCount: number;
    dueBytes: string;
    recycleDays: number;
  };
  /** 已用超过配额的用户(配额被下调后可能出现) */
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
  /** 敏感值的掩码(如 sk-****3f9a);非敏感值为 null */
  valueMasked: string | null;
  hasSecret: boolean;
}

/** 供社区/分享模块内部调用的公开分享配置。**绝不含任何 secret**。 */
export interface PublicShareConfig {
  publicOrigin: string;
  wechat: { enabled: boolean; appId: string; jsApiDomain: string; configured: boolean };
  qq: { enabled: boolean; appId: string };
  /** 二维码兜底始终可用,不依赖任何第三方凭据 */
  qrcodeEnabled: boolean;
  version: number;
}
