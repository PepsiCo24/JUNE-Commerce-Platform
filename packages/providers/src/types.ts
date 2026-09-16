/**
 * 供应商适配层的统一抽象。
 *
 * 设计原则:
 *  1. 适配器只负责「一次上游调用」。当模型 limits.maxOutputsPerCall 小于用户请求张数时,
 *     拆分次数由上层 Worker 通过 @june/shared 的 countUpstreamCalls 决定,适配器内部
 *     绝不循环重试或循环出图 —— 否则计费、限流、失败项重试都会失去可观测性。
 *  2. 结果分三态而不是两态:completed / pending / failed。
 *     异步供应商(提交后轮询)返回 pending,由上层调度轮询,适配器不阻塞等待。
 *  3. failed 必须区分「确定失败」与「结果未知」:
 *     - 确定失败(参数错误、鉴权失败、内容审核拒绝)→ 可安全重试或直接告知用户;
 *     - 结果未知(网络超时、连接中断、网关 5xx)→ errorCode = UPSTREAM_RESULT_UNKNOWN,
 *       上层必须先核对再决定,禁止盲目重试,因为上游可能已经执行并计费。
 *  4. 任何返回给上层的 message 都必须经过 sanitizeUpstreamMessage 脱敏,
 *     绝不允许 apiKey、Authorization 头、完整请求体、base64 图片进入日志或错误文案。
 */

import type { ErrorCode, ModelLimits } from '@june/shared';

// ---------------------------------------------------------------------------
// 供应商标识
// ---------------------------------------------------------------------------

export const PROVIDER_KINDS = [
  'OPENAI',
  'GEMINI',
  'ARK_SEEDREAM',
  'ALIYUN_WANX',
  'BFL_FLUX',
  'OPENAI_COMPATIBLE',
  'MOCK',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** 与 @june/shared 的 PublicModelOption.capabilities 保持一致 */
export const MODEL_CAPABILITIES = ['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'TEXT'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// 凭据与调用选项
// ---------------------------------------------------------------------------

/**
 * 供应商凭据。
 * baseUrl 必须由后台配置并通过白名单校验(PROVIDER_URL_NOT_ALLOWED),
 * 适配器不内置可变的默认地址以外的任何跳转逻辑。
 */
export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
}

/** 单次上游调用的运行时选项 */
export interface ProviderCallOptions {
  /** 单次 HTTP 调用超时,默认 DEFAULT_TIMEOUT_MS(120s) */
  timeoutMs?: number;
  /** 上层取消信号(用户取消任务 / 进程优雅退出) */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// 生图请求
// ---------------------------------------------------------------------------

export interface ReferenceImage {
  data: Buffer | Uint8Array;
  mimeType: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  /** 本次调用希望产出的张数。上层保证 <= limits.maxOutputsPerCall */
  count: number;
  /** sizeMode = 'size_string' 时使用,形如 "1024x1024" */
  size?: string;
  /** sizeMode = 'aspect_ratio' 时使用,形如 "16:9" */
  aspectRatio?: string;
  /** sizeMode = 'width_height' 时使用 */
  width?: number;
  height?: number;
  seed?: number;
  /** 参考图 / 图生图输入。数量上限由 limits.maxReferenceImages 决定 */
  referenceImages?: ReferenceImage[];
  /** 供应商侧真实模型标识 */
  modelKey: string;
  /**
   * 供应商特有参数(如 Ark 的 watermark、Gemini 的 image_size、FLUX 的 safety_tolerance)。
   * 由后台模型配置注入,适配器按各自文档取用,未识别的键一律忽略而不是透传。
   */
  extraParams: Record<string, unknown>;
}

export interface GeneratedImage {
  /** 上游返回临时链接时使用。必须在 limits.resultUrlTtlSeconds 内转存 */
  url?: string;
  /** 上游直接返回 base64 时使用(不含 data URI 前缀) */
  base64?: string;
  mimeType: string;
  width?: number;
  height?: number;
}

/** 失败详情。pending / completed 之外的第三态 */
export interface ProviderFailure {
  kind: 'failed';
  errorCode: ErrorCode;
  /** 已脱敏的中文/英文提示,可安全写入日志与数据库 */
  message: string;
  /**
   * 是否可以安全重试。
   * errorCode 为 UPSTREAM_RESULT_UNKNOWN 时该值恒为 false:
   * 结果未知意味着可能已计费,必须先核对。
   */
  retryable: boolean;
  httpStatus?: number;
  /** 结果未知时若已拿到上游任务号,带出来供人工/定时核对 */
  providerTaskId?: string;
  /** 429 场景解析自 Retry-After 响应头 */
  retryAfterSeconds?: number;
}

export type ImageGenerationOutcome =
  | {
      kind: 'completed';
      images: GeneratedImage[];
      upstreamDurationMs: number;
      providerTaskId?: string;
    }
  | {
      kind: 'pending';
      providerTaskId: string;
      /** 建议的下次轮询间隔(毫秒)。上游未给出时由上层退避策略决定 */
      pollAfterMs?: number;
    }
  | ProviderFailure;

export type PollOutcome = ImageGenerationOutcome;

// ---------------------------------------------------------------------------
// 模型描述
// ---------------------------------------------------------------------------

export interface ModelDescriptor {
  /** 供应商侧真实模型标识,直接用于请求体 */
  modelKey: string;
  displayName: string;
  capabilities: ModelCapability[];
  limits: ModelLimits;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** 已脱敏的诊断信息 */
  message: string;
  httpStatus?: number;
  latencyMs: number;
  errorCode?: ErrorCode;
}

// ---------------------------------------------------------------------------
// 生图适配器接口
// ---------------------------------------------------------------------------

export interface ImageProvider {
  readonly kind: ProviderKind;
  /** 发起一次上游调用。同步供应商返回 completed,异步供应商返回 pending */
  submit(
    req: ImageGenerationRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<ImageGenerationOutcome>;
  /** 仅异步供应商实现(limits.deliveryMode = 'async_poll') */
  poll?(
    providerTaskId: string,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<PollOutcome>;
  describeDefaultModels(): ModelDescriptor[];
  testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult>;
}

// ---------------------------------------------------------------------------
// 文本适配器接口
// ---------------------------------------------------------------------------

export interface StructuredTextRequest {
  modelKey: string;
  systemPrompt: string;
  userPrompt: string;
  /** 期望的 JSON Schema。上层用 zod 生成或手写,适配器只负责按各家协议传递 */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens?: number;
  /** OpenAI json_schema 模式要求的名称,需匹配 ^[a-zA-Z0-9_-]{1,64}$ */
  schemaName?: string;
  temperature?: number;
}

export type StructuredTextOutcome =
  | {
      kind: 'completed';
      /** 上游返回的原始字符串。不可直接信任,由上层用 zod 校验 */
      raw: string;
      /**
       * raw 的 JSON.parse 结果。仅表示「语法是合法 JSON」,
       * 不表示「结构符合业务 schema」。结构校验必须由上层完成。
       */
      parsed: unknown;
      upstreamDurationMs: number;
      finishReason?: string;
    }
  | ProviderFailure;

export interface TextProvider {
  readonly kind: ProviderKind;
  generateStructured(
    req: StructuredTextRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<StructuredTextOutcome>;
  describeDefaultModels(): ModelDescriptor[];
  testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult>;
}
