import { z } from 'zod';

import {
  COPY_STYLES,
  IMAGE_COUNT_MAX,
  IMAGE_COUNT_MIN,
  NEGATIVE_PROMPT_MAX,
  PROMPT_MAX,
  REFERENCE_IMAGE_MAX,
  TARGET_PLATFORMS,
  TASK_STAGES,
} from '../constants';
import type { ModelLimits } from '../model-capabilities';
import { cursorQuerySchema, idSchema } from './common';

export const TASK_STATUSES = [
  'QUEUED',
  'RUNNING',
  'PARTIAL',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'TIMEOUT',
  'UNKNOWN',
] as const;
export type TaskStatusValue = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatusValue, string> = {
  QUEUED: '排队中',
  RUNNING: '生成中',
  PARTIAL: '部分成功',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELED: '已取消',
  TIMEOUT: '超时',
  UNKNOWN: '结果待确认',
};

// ---------------------------------------------------------------------------
// 生图
// ---------------------------------------------------------------------------

export const imageGenerateSchema = z.object({
  /**
   * 用户选择的模型。后台设置为"固定单模型"时该字段被忽略,
   * 后端强制使用指定模型,前端也会隐藏选择器。改请求参数无法绕过。
   */
  modelConfigId: idSchema.optional(),
  prompt: z.string().trim().min(1, '请输入提示词').max(PROMPT_MAX),
  negativePrompt: z.string().trim().max(NEGATIVE_PROMPT_MAX).nullable().optional(),
  count: z.coerce.number().int().min(IMAGE_COUNT_MIN).max(IMAGE_COUNT_MAX).default(1),
  /** 三种尺寸表达按模型 limits.sizeMode 取其一 */
  size: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/)
    .nullable()
    .optional(),
  aspectRatio: z
    .string()
    .regex(/^\d{1,2}:\d{1,2}$/)
    .nullable()
    .optional(),
  width: z.coerce.number().int().min(64).max(8192).nullable().optional(),
  height: z.coerce.number().int().min(64).max(8192).nullable().optional(),
  seed: z.coerce.number().int().min(0).max(4_294_967_295).nullable().optional(),
  /** 参考图。数量上限由模型 limits.maxReferenceImages 决定 */
  referenceAssetIds: z.array(idSchema).max(REFERENCE_IMAGE_MAX).default([]),
  /**
   * 幂等键。同一用户使用相同幂等键重复提交时返回已存在的任务,
   * 避免网络重试造成重复付费调用。前端在打开表单时生成并在成功后重置。
   */
  idempotencyKey: z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/),
});
export type ImageGenerateInput = z.infer<typeof imageGenerateSchema>;

/** 失败项重试:只重试失败的序号,已成功的图片不重复生成 */
export const imageRetrySchema = z.object({
  /** 为空表示重试该任务下全部失败项 */
  seqs: z.array(z.number().int().min(0).max(64)).max(64).default([]),
  idempotencyKey: z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/),
});

export const saveResultToProductSchema = z.object({
  productId: idSchema,
  /** 要保存的结果 id 列表 */
  resultIds: z.array(idSchema).min(1).max(32),
  /** 是否同时设为商品封面(取第一张) */
  setAsCover: z.boolean().default(false),
});

export const saveResultToPostSchema = z.object({
  postId: idSchema,
  resultIds: z.array(idSchema).min(1).max(32),
});

export const taskListQuerySchema = cursorQuerySchema.extend({
  type: z.enum(['IMAGE_GENERATE', 'IMAGE_EDIT', 'TEXT_COPY', 'ALL']).default('ALL'),
  status: z.enum(['ALL', ...TASK_STATUSES]).default('ALL'),
});

export interface GenerationResultView {
  id: string;
  seq: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  /** 生图结果 */
  asset: {
    id: string;
    url: string;
    previewUrl: string | null;
    thumbUrl: string | null;
    width: number | null;
    height: number | null;
    byteSize: number;
  } | null;
  /** 文案结果 */
  text: CopyResultPayload | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** 内容检查结果(文案) */
  check: ContentCheckOutcome | null;
}

export interface GenerationTaskView {
  id: string;
  type: 'IMAGE_GENERATE' | 'IMAGE_EDIT' | 'TEXT_COPY';
  status: TaskStatusValue;
  stage: (typeof TASK_STAGES)[number];
  /** 仅当上游返回真实百分比时才有值;为 null 时前端只展示阶段文案 */
  progressPercent: number | null;
  /** 提交时的模型快照,模型被删除或停用后历史记录仍可展示 */
  model: {
    id: string | null;
    displayName: string;
    providerSlug: string;
    modelKey: string;
    /** 是否为压测用模拟供应商 */
    isMock: boolean;
  };
  /** 生成参数(不含任何密钥),用于"查看生成参数" */
  params: Record<string, unknown>;
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  results: GenerationResultView[];
  referenceImages: Array<{ assetId: string; thumbUrl: string | null }>;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 排队等待与上游耗时分开展示,便于区分平台能力与上游速度 */
  queueWaitMs: number | null;
  upstreamDurationMs: number | null;
}

/** 提交响应:快速返回任务 ID */
export interface TaskSubmitResponse {
  taskId: string;
  status: TaskStatusValue;
  /** 命中幂等键时为 true,表示复用了已有任务 */
  deduplicated: boolean;
  /** 队列中的大致位置,仅供提示 */
  queuePosition: number | null;
}

/** 前端渲染表单所需的可用模型信息(公开配置,绝不含密钥) */
export interface PublicModelOption {
  id: string;
  displayName: string;
  providerSlug: string;
  providerName: string;
  capabilities: Array<'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'TEXT'>
  isDefault: boolean;
  limits: ModelLimits;
  /** 模拟供应商必须显式标识 */
  isMock: boolean;
}

/**
 * 模型选择策略。fixed 模式下前端隐藏选择器,后端强制使用 fixedModelId。
 */
export interface ModelSelectionPolicy {
  image: { mode: 'user_selectable' | 'fixed'; fixedModelId: string | null };
  text: { mode: 'user_selectable' | 'fixed'; fixedModelId: string | null };
}

export interface PublicModelConfigResponse {
  /** 配置版本号。SSE 推送该版本号,前端据此补拉 */
  version: number;
  policy: ModelSelectionPolicy;
  imageModels: PublicModelOption[];
  textModels: PublicModelOption[];
  concurrency: {
    imagePerUserRunning: number;
    imagePerUserPending: number;
  };
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

export const copyGenerateSchema = z
  .object({
    modelConfigId: idSchema.optional(),
    /** 可选择本人已有商品,自动带入商品资料 */
    productId: idSchema.nullable().optional(),
    /** 手工填写的商品资料(未选择商品时使用) */
    productName: z.string().trim().max(200).optional(),
    productDetails: z.string().trim().max(4000).optional(),
    /** 卖点,逐条 */
    sellingPoints: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
    targetPlatform: z.enum(TARGET_PLATFORMS.map((p) => p.value) as [string, ...string[]]),
    style: z.enum(COPY_STYLES.map((s) => s.value) as [string, ...string[]]),
    /** 用户附加提示词。属于待处理内容,不能覆盖系统规则 */
    prompt: z.string().trim().max(PROMPT_MAX).optional(),
    /** 期望生成的标题数量 */
    titleCount: z.coerce.number().int().min(1).max(10).default(5),
    idempotencyKey: z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/),
  })
  .refine((v) => !!v.productId || !!v.productName || !!v.prompt, {
    message: '请选择商品或填写商品名称/提示词',
    path: ['productName'],
  });
export type CopyGenerateInput = z.infer<typeof copyGenerateSchema>;

/** 模型的结构化输出格式。后端会用该 schema 校验模型返回,不合规则重试或拦截。 */
export const copyResultPayloadSchema = z.object({
  titles: z.array(z.string().min(1).max(300)).min(1).max(10),
  body: z.string().min(1).max(8000),
  /** 模型给出的卖点提炼,可选 */
  highlights: z.array(z.string().min(1).max(200)).max(12).default([]),
  /** 关键词/标签建议,可选 */
  keywords: z.array(z.string().min(1).max(60)).max(20).default([]),
});
export type CopyResultPayload = z.infer<typeof copyResultPayloadSchema>;

/** 内容检查结论 */
export interface ContentCheckOutcome {
  passed: boolean;
  /** 检查阶段:input / output */
  phase: 'input' | 'output';
  violations: Array<{
    ruleId: string;
    ruleName: string;
    ruleType: 'BANNED_WORD' | 'BANNED_PHRASE' | 'BANNED_CATEGORY' | 'PLATFORM_RULE' | 'SYSTEM_PROMPT';
    action: 'BLOCK' | 'REWRITE' | 'WARN';
    /** 命中的片段(已截断),不回显完整敏感内容 */
    matched: string;
    field: string;
  }>;
  /** 触发有限次数重写的次数 */
  rewriteCount: number;
  /** 检查耗时 */
  durationMs: number;
}

/** 保存用户编辑后的文案:同样执行适用的输出检查 */
export const copySaveSchema = z.object({
  productId: idSchema,
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(8000),
  /** 来源任务,便于追溯 */
  sourceTaskId: idSchema.nullable().optional(),
});
export type CopySaveInput = z.infer<typeof copySaveSchema>;

export interface CopySaveResponse {
  productId: string;
  check: ContentCheckOutcome;
  saved: boolean;
  /**
   * 免责说明:平台按配置规则执行检查,但不保证第三方平台审核必定通过。
   */
  disclaimer: string;
}

export const CONTENT_CHECK_DISCLAIMER =
  '平台已按后台配置的内容规则完成检查,但各电商平台审核标准会独立调整,平台不保证第三方审核必定通过,请发布前再次自查。';
