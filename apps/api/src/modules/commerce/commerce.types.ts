/**
 * 本模块内部使用的响应/上下文类型。
 *
 * 跨端契约(ShopSummary / ProductDetail / ImportJobStatus 等)一律来自 @june/shared,
 * 这里只放契约里没有、且仅本模块使用的形状。
 */

/** @ClientInfo() 注入的审计上下文 */
export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

/** 删除店铺的执行结果:明确告知各类依赖被如何处理,不做静默级联 */
export interface ShopDeleteResult {
  id: string;
  childrenStrategy: string;
  childrenAffected: number;
  productsStrategy: string;
  productsAffected: number;
  credentialsStrategy: string;
  credentialsAffected: number;
}

/** 文案页面用的轻量商品选项 */
export interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
  shopName: string;
}

/** 导入入队结果。API 只返回 jobId,真正的逐行导入由 Worker 执行。 */
export interface ImportEnqueueResult {
  jobId: string;
  totalRows: number;
}
