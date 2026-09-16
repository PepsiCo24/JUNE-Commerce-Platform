/**
 * 管理站 query key。第一段统一为 'admin',便于整体失效。
 *
 * 约定(与 WEB_UI_CONTRACT 第 3 节一致):
 *  - 所有筛选条件都进 key,保证换筛选条件就是一次新查询;
 *  - 需要"配置变更即刷新"的查询把 `useSse().configVersions.models` 拼进 key。
 */

type Params = Record<string, unknown>;

export const adminKeys = {
  all: ['admin'] as const,

  session: ['admin', 'session'] as const,

  dashboard: (params: Params) => ['admin', 'dashboard', params] as const,
  dashboardMeta: ['admin', 'dashboard', 'meta'] as const,

  users: (params: Params) => ['admin', 'users', params] as const,
  user: (id: string) => ['admin', 'users', 'detail', id] as const,
  userShops: (id: string) => ['admin', 'users', 'shops', id] as const,
  userShopProducts: (id: string, shopId: string) => ['admin', 'users', 'shops', id, shopId, 'products'] as const,

  posts: (params: Params) => ['admin', 'content', 'posts', params] as const,
  post: (id: string) => ['admin', 'content', 'posts', 'detail', id] as const,
  comments: (params: Params) => ['admin', 'content', 'comments', params] as const,

  providers: (configVersion: number) => ['admin', 'models', 'providers', configVersion] as const,
  modelConfigs: (configVersion: number) => ['admin', 'models', 'configs', configVersion] as const,
  modelPolicy: (configVersion: number) => ['admin', 'models', 'policy', configVersion] as const,

  contentRules: (params: Params) => ['admin', 'content-rules', params] as const,
  contentRuleVersions: (id: string) => ['admin', 'content-rules', 'versions', id] as const,

  shareConfig: ['admin', 'share-config'] as const,

  tasks: (params: Params) => ['admin', 'tasks', params] as const,
  task: (id: string) => ['admin', 'tasks', 'detail', id] as const,
  taskStats: (params: Params) => ['admin', 'tasks', 'stats', params] as const,

  storageOverview: (params: Params) => ['admin', 'storage', 'overview', params] as const,
  storageQuotaBounds: ['admin', 'storage', 'quota-bounds'] as const,
  cleanupRuns: (params: Params) => ['admin', 'storage', 'cleanup-runs', params] as const,

  systemConfigs: (params: Params) => ['admin', 'system-configs', params] as const,

  auditLogs: (params: Params) => ['admin', 'audit-logs', params] as const,
  auditLogOptions: ['admin', 'audit-logs', 'actions'] as const,
} as const;
