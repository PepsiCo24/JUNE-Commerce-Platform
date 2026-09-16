/**
 * 跨端共享常量。前后端共用同一份定义,避免"前端放宽、后端收紧"造成的行为不一致。
 */

// ---------------------------------------------------------------------------
// 品牌名称。拼写受保护,任何页面都不得改写或附加未经要求的口号。
// ---------------------------------------------------------------------------
export const BRAND_FULL_NAME = 'JUNE-Commerce-Platform';
export const BRAND_SHORT_NAME = 'JUNE';
export const BRAND_LOGO_SUBTITLE = 'COMMERCE PLATFORM';
/** 页面标题模板:"页面名称 · JUNE" */
export const TITLE_SEPARATOR = ' · ';

/** 页面标题片段。根布局 template 会再拼「 · JUNE」,这里只返回页面名,避免「登录 · JUNE · JUNE」。 */
export function pageTitle(pageName: string): string {
  return pageName;
}

// ---------------------------------------------------------------------------
// 分页。默认每页 20,上限 100;大列表使用游标分页。
// ---------------------------------------------------------------------------
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

// ---------------------------------------------------------------------------
// 社区
// ---------------------------------------------------------------------------
/**
 * 帖子大厅排序。
 * - latest: 发布时间
 * - most_liked / most_commented: 点赞数 / 评论数(与 hot 不同)
 * - hot: 加权热度分(点赞+评论+浏览+时间衰减),定时重算
 */
export const POST_SORT_OPTIONS = ['latest', 'most_liked', 'most_commented', 'hot'] as const;
export type PostSort = (typeof POST_SORT_OPTIONS)[number];

/** 社区搜索结果类型 */
export const COMMUNITY_SEARCH_TYPES = ['all', 'posts', 'users'] as const;
export type CommunitySearchType = (typeof COMMUNITY_SEARCH_TYPES)[number];

/** 全站主题偏好:日间 / 夜间 / 跟随系统 */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * 热门排序规则(明确口径,前端提示文案与后端计算共用):
 *   hotScore = (likeCount * 3 + commentCount * 5 + min(viewCount, 5000) * 0.1 + 1)
 *              / pow(hoursSincePublish + 2, 1.5)
 * - 权重体现"评论 > 点赞 > 浏览"
 * - 浏览量封顶,避免刷量主导排序
 * - 时间衰减保证新内容有机会曝光
 * - 由定时任务每 5 分钟重算,置顶帖不参与热门排序但始终优先展示
 */
export const HOT_SCORE_WEIGHTS = {
  like: 3,
  comment: 5,
  view: 0.1,
  viewCap: 5000,
  gravity: 1.5,
  timeOffsetHours: 2,
  recomputeIntervalSeconds: 300,
} as const;

export const POST_TITLE_MAX = 200;
export const POST_EXCERPT_MAX = 300;
export const POST_CONTENT_MAX_BYTES = 512 * 1024;
export const POST_MAX_IMAGES = 30;
export const COMMENT_MAX = 2000;
/** 草稿自动保存防抖(毫秒) */
export const DRAFT_AUTOSAVE_DEBOUNCE_MS = 1200;

// ---------------------------------------------------------------------------
// 店铺 / 商品
// ---------------------------------------------------------------------------
export const SHOP_NAME_MAX = 120;
/** 主子店层级上限,防止无意义的深层嵌套(当前业务只使用 主店 -> 子店 两级) */
export const SHOP_MAX_DEPTH = 2;

/**
 * 子店铺默认继承的字段(唯一来源,前后端共用)。
 * 账号密码不在其中:凭据必须独立管理,不做任何自动继承。
 */
export const INHERITABLE_SHOP_FIELDS = [
  { field: 'platform', label: '平台' },
  { field: 'contactName', label: '联系人' },
  { field: 'contactInfo', label: '联系方式' },
  { field: 'note', label: '备注' },
] as const;

export const INHERITABLE_SHOP_FIELD_VALUES = ['platform', 'contactName', 'contactInfo', 'note'] as const;

export type InheritableShopField = (typeof INHERITABLE_SHOP_FIELD_VALUES)[number];

export const INHERITABLE_SHOP_FIELD_LABELS: Record<InheritableShopField, string> = {
  platform: '平台',
  contactName: '联系人',
  contactInfo: '联系方式',
  note: '备注',
};
export const PRODUCT_NAME_MAX = 200;
export const PRODUCT_SKU_MAX = 80;
export const PRODUCT_IMPORT_MAX_ROWS = 5000;
export const PRODUCT_CSV_COLUMNS = [
  'name',
  'sku',
  'title',
  'description',
  'price',
  'currency',
  'stock',
  'status',
  'attributes',
] as const;

/** 常见目标平台。用于文案生成的平台规则与店铺平台字段的建议值(允许自定义输入) */
export const TARGET_PLATFORMS = [
  { value: 'taobao', label: '淘宝 / 天猫' },
  { value: 'jd', label: '京东' },
  { value: 'pdd', label: '拼多多' },
  { value: 'douyin', label: '抖音电商' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'wechat_store', label: '微信小店' },
  { value: 'amazon', label: 'Amazon' },
  { value: 'shopee', label: 'Shopee' },
  { value: 'tiktok_shop', label: 'TikTok Shop' },
  { value: 'other', label: '其他' },
] as const;

export const COPY_STYLES = [
  { value: 'professional', label: '专业严谨' },
  { value: 'warm', label: '亲切温和' },
  { value: 'concise', label: '简洁直接' },
  { value: 'lively', label: '活泼种草' },
  { value: 'premium', label: '高端质感' },
] as const;

// ---------------------------------------------------------------------------
// 资产 / 上传
// ---------------------------------------------------------------------------
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;
export const ALLOWED_IMPORT_MIME_TYPES = ['text/csv', 'application/vnd.ms-excel', 'text/plain'] as const;

/** 派生图规格。列表读 thumb,详情读 preview,下载读原图。 */
export const DERIVATIVE_SPECS = {
  thumb: { maxWidth: 400, maxHeight: 400, quality: 78 },
  preview: { maxWidth: 1600, maxHeight: 1600, quality: 82 },
} as const;
export type DerivativeName = keyof typeof DERIVATIVE_SPECS;

/** 响应式图片尺寸档位,配合 next/image sizes 使用 */
export const IMAGE_SIZE_STEPS = [200, 400, 800, 1200, 1600] as const;

// ---------------------------------------------------------------------------
// 生成任务
// ---------------------------------------------------------------------------
export const IMAGE_COUNT_MIN = 1;
export const IMAGE_COUNT_MAX = 8;
export const PROMPT_MAX = 4000;
export const NEGATIVE_PROMPT_MAX = 1000;
export const REFERENCE_IMAGE_MAX = 6;

/**
 * 任务阶段。供应商未返回真实百分比时,前端只展示阶段文案,不编造进度条数值。
 */
export const TASK_STAGES = [
  'queued',
  'submitting',
  'generating',
  'polling',
  'downloading',
  'checking',
  'done',
] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

export const TASK_STAGE_LABELS: Record<TaskStage, string> = {
  queued: '排队中',
  submitting: '提交中',
  generating: '生成中',
  polling: '等待结果',
  downloading: '转存图片',
  checking: '内容检查',
  done: '已完成',
};

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
/** 每标签页复用一条 SSE 连接的路径 */
export const SSE_PATH = '/api/events/stream';
/** 心跳间隔(毫秒),需小于 Nginx proxy_read_timeout */
export const SSE_HEARTBEAT_MS = 20_000;
/** 断线重连基准延迟(毫秒),客户端做指数退避 */
export const SSE_RECONNECT_BASE_MS = 1_000;
export const SSE_RECONNECT_MAX_MS = 30_000;
/** SSE 不可用时的降级轮询间隔(毫秒) */
export const SSE_FALLBACK_POLL_MS = 15_000;
/** 配置变更到前端生效的目标时延(毫秒),验收指标 */
export const CONFIG_SYNC_TARGET_MS = 2_000;

// ---------------------------------------------------------------------------
// 安全
// ---------------------------------------------------------------------------
export const CSRF_HEADER = 'x-june-csrf';
export const CSRF_COOKIE = 'june_csrf';
export const SESSION_COOKIE_SITE = 'june_session';
export const SESSION_COOKIE_ADMIN = 'june_admin_session';
/** 查看店铺密码需要的重新验证令牌请求头 */
export const REAUTH_HEADER = 'x-june-reauth';
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
