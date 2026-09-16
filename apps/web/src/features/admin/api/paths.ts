/**
 * 管理站接口路径的唯一来源。
 *
 * 全部以控制器声明为准(`@Controller('admin/...')`),前缀 `/api` 由 api 客户端补齐。
 * 集中在这里的原因:后端并行开发时若某个控制器的挂载路径调整,只改这一个文件。
 */

export const ADMIN_PATHS = {
  auth: {
    login: '/admin/auth/login',
    me: '/admin/auth/me',
    logout: '/admin/auth/logout',
  },

  dashboard: {
    overview: '/admin/dashboard',
    meta: '/admin/dashboard/meta',
    refresh: '/admin/dashboard/refresh',
  },

  users: {
    list: '/admin/users',
    create: '/admin/users',
    detail: (id: string) => `/admin/users/${id}`,
    shops: (id: string) => `/admin/users/${id}/shops`,
    shopProducts: (id: string, shopId: string) => `/admin/users/${id}/shops/${shopId}/products`,
    status: (id: string) => `/admin/users/${id}/status`,
    roles: (id: string) => `/admin/users/${id}/roles`,
  },

  content: {
    posts: '/admin/posts',
    post: (id: string) => `/admin/posts/${id}`,
    postVisibility: (id: string) => `/admin/posts/${id}/visibility`,
    postPin: (id: string) => `/admin/posts/${id}/pin`,
    pinReorder: '/admin/posts/pin-order',
    comments: '/admin/comments',
    commentAction: (id: string) => `/admin/comments/${id}/action`,
  },

  models: {
    providers: '/admin/models/providers',
    provider: (id: string) => `/admin/models/providers/${id}`,
    providerTest: (id: string) => `/admin/models/providers/${id}/test`,
    policy: '/admin/models/policy',
    list: '/admin/models',
    detail: (id: string) => `/admin/models/${id}`,
    setDefault: (id: string) => `/admin/models/${id}/default`,
  },

  contentRules: {
    list: '/admin/content-rules',
    detail: (id: string) => `/admin/content-rules/${id}`,
    versions: (id: string) => `/admin/content-rules/${id}/versions`,
    enabled: (id: string) => `/admin/content-rules/${id}/enabled`,
  },

  shareConfig: '/admin/share-config',

  tasks: {
    list: '/admin/tasks',
    stats: '/admin/tasks/stats',
    detail: (id: string) => `/admin/tasks/${id}`,
  },

  storage: {
    overview: '/admin/storage/overview',
    quotaBounds: '/admin/storage/quota-bounds',
    quota: (userId: string) => `/admin/storage/users/${userId}/quota`,
    cleanup: '/admin/storage/cleanup',
    cleanupRuns: '/admin/storage/cleanup-runs',
  },

  systemConfigs: {
    list: '/admin/system-configs',
    detail: (key: string) => `/admin/system-configs/${encodeURIComponent(key)}`,
  },

  auditLogs: {
    list: '/admin/audit-logs',
    actions: '/admin/audit-logs/actions',
  },
} as const;
