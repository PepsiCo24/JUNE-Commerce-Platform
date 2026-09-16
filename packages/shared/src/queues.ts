/**
 * 队列契约:API(生产者)与 Worker(消费者)之间的唯一约定。
 * 队列名与任务载荷类型都定义在这里,避免两侧字符串不一致导致任务永远没人消费。
 */

export const QUEUE_NAMES = {
  /** 生图任务 */
  imageGeneration: 'image-generation',
  /** 文案生成任务 */
  textGeneration: 'text-generation',
  /** 缩略图 / 预览图派生 */
  imageDerive: 'image-derive',
  /** 商品 CSV 批量导入 */
  productImport: 'product-import',
  /** 清理与维护(孤儿文件、过期上传、回收期到期、队列记录、热门分重算) */
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---------------------------------------------------------------------------
// 任务载荷
// ---------------------------------------------------------------------------

export interface ImageGenerationJob {
  taskId: string;
  userId: string;
  /**
   * 本次要产出的结果序号。失败项重试时只传失败的 seq,
   * 已成功的图片不会重复生成、也不会重复计费。
   */
  seqs: number[];
  /** 提交时的模型配置版本号,Worker 启动前会重新校验模型是否已被停用 */
  configVersion: number;
  attempt: number;
}

export interface TextGenerationJob {
  taskId: string;
  userId: string;
  configVersion: number;
  attempt: number;
}

export interface ImageDeriveJob {
  assetId: string;
  ownerId: string;
}

export interface ProductImportJob {
  importJobId: string;
  ownerId: string;
}

export type MaintenanceJobKind =
  | 'cleanup_expired_upload'
  | 'cleanup_orphan_asset'
  | 'purge_recycled_asset'
  | 'prune_queue_records'
  | 'prune_sessions'
  | 'recompute_hot_scores'
  | 'reconcile_unknown_tasks'
  | 'rewrap_secrets';

export interface MaintenanceJob {
  kind: MaintenanceJobKind;
  /** 预览模式:只统计不删除 */
  dryRun: boolean;
  limit: number;
  /** 触发者(管理员 id 或 'scheduler') */
  triggeredBy: string;
  /** 幂等键:同一 kind 的同一批次重跑不会重复计数 */
  runKey?: string;
}

export interface QueuePayloadMap {
  [QUEUE_NAMES.imageGeneration]: ImageGenerationJob;
  [QUEUE_NAMES.textGeneration]: TextGenerationJob;
  [QUEUE_NAMES.imageDerive]: ImageDeriveJob;
  [QUEUE_NAMES.productImport]: ProductImportJob;
  [QUEUE_NAMES.maintenance]: MaintenanceJob;
}

// ---------------------------------------------------------------------------
// 并发闸门用的 Redis 键
// ---------------------------------------------------------------------------

export const CONCURRENCY_KEYS = {
  /** 全局运行中计数(覆盖所有 Worker 实例) */
  imageGlobalRunning: 'gate:image:running',
  textGlobalRunning: 'gate:text:running',
  /** 每用户运行中计数 */
  imageUserRunning: (userId: string) => `gate:image:user:${userId}:running`,
  /** 供应商级频率限制(按分钟窗口) */
  providerRateWindow: (providerSlug: string, minuteBucket: number) =>
    `gate:provider:${providerSlug}:${minuteBucket}`,
  /** 供应商级并发 */
  providerRunning: (providerSlug: string) => `gate:provider:${providerSlug}:running`,
} as const;

/**
 * BullMQ 任务保留策略。队列记录不能无限增长,
 * 但权威任务状态在 PostgreSQL 的 GenerationTask,删除队列记录不会丢业务数据。
 */
export const QUEUE_RETENTION = {
  /** 完成的任务保留条数 */
  completedCount: 1_000,
  /** 失败的任务保留条数(便于排查) */
  failedCount: 5_000,
  /** 完成的任务保留时长(秒) */
  completedAgeSeconds: 24 * 3600,
  failedAgeSeconds: 7 * 24 * 3600,
} as const;
