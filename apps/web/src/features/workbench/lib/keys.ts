/**
 * 工作台的 React Query key。
 *
 * 约定(见 WEB_UI_CONTRACT 第 3 节):第一段固定为 'workbench'。
 * 模型配置的 key 里必须带 SSE 下发的 configVersions.models,
 * 后台改动模型配置后版本号变化,查询自动失效并补拉公开配置。
 */

export const workbenchKeys = {
  all: ['workbench'] as const,

  modelConfig: (version: number) => ['workbench', 'models', 'config', version] as const,

  taskList: (params: Record<string, unknown>) => ['workbench', 'tasks', 'list', params] as const,
  task: (taskId: string) => ['workbench', 'tasks', 'detail', taskId] as const,

  shopList: (params: object) => ['workbench', 'shops', 'list', params] as const,
  shopStats: () => ['workbench', 'shops', 'stats'] as const,
  shopGraph: () => ['workbench', 'shops', 'graph'] as const,
  shopDetail: (shopId: string) => ['workbench', 'shops', 'detail', shopId] as const,
  shopOptions: () => ['workbench', 'shops', 'options'] as const,

  productList: (params: object) => ['workbench', 'products', 'list', params] as const,
  productDetail: (productId: string) => ['workbench', 'products', 'detail', productId] as const,
  productOptions: (q: string, shopId?: string) => ['workbench', 'products', 'options', q, shopId ?? ''] as const,

  importJob: (jobId: string) => ['workbench', 'products', 'import', jobId] as const,

  alipayList: (params: Record<string, unknown>) => ['workbench', 'alipay', 'list', params] as const,

  storageUsage: () => ['workbench', 'storage', 'usage'] as const,
} as const;
