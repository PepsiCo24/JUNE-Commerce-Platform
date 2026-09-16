/**
 * 后端有返回、但尚未收入 @june/shared 的响应形状。
 * 字段与控制器/服务实现保持一致,前端只消费不发明。
 */

export interface BatchDownloadItem {
  resultId: string;
  assetId: string;
  fileName: string;
  url: string;
}

export interface SaveResultsResponse {
  targetId: string;
  savedCount: number;
  skippedCount: number;
}

export interface ImportEnqueueResult {
  jobId: string;
  totalRows: number;
}

export interface ShopDeleteResult {
  id: string;
  childrenStrategy: string;
  childrenAffected: number;
  productsStrategy: string;
  productsAffected: number;
  credentialsStrategy: string;
  credentialsAffected: number;
}
