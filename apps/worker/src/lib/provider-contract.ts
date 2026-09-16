/**
 * 供应商适配层接口的**本地结构镜像**。
 *
 * 依赖说明(重要):
 *   Worker 运行时使用的是 `@june/providers`(packages/providers)。该包由另一任务实现,
 *   在本任务编写时其 `src/index.ts` / `src/registry.ts` 尚未产出,直接 `import` 会让
 *   typecheck 失败。因此这里按 `packages/providers/src/types.ts` 抄一份**结构等价**的
 *   类型声明,Worker 只面向这些接口编程,运行期通过 provider-registry.ts 动态取真实实现。
 *
 * 契约来源(必须保持一致,改动以 packages/providers/src/types.ts 为准):
 *   - ImageProvider.submit(req, creds, options) -> ImageGenerationOutcome
 *   - ImageProvider.poll?(providerTaskId, creds, options) -> PollOutcome
 *   - TextProvider.generateStructured(req, creds, options) -> StructuredTextOutcome
 *   - 结果三态:completed / pending / failed
 *   - failed 中 errorCode = UPSTREAM_RESULT_UNKNOWN 时 retryable 恒为 false(可能已计费)
 */
import type { ErrorCode, ModelLimits } from '@june/shared';

export type ProviderKindValue =
  | 'OPENAI'
  | 'GEMINI'
  | 'ARK_SEEDREAM'
  | 'ALIYUN_WANX'
  | 'BFL_FLUX'
  | 'OPENAI_COMPATIBLE'
  | 'MOCK';

export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface ProviderCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ReferenceImage {
  data: Buffer | Uint8Array;
  mimeType: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  /** 本次调用希望产出的张数。上层保证 <= limits.maxOutputsPerCall */
  count: number;
  size?: string;
  aspectRatio?: string;
  width?: number;
  height?: number;
  seed?: number;
  referenceImages?: ReferenceImage[];
  modelKey: string;
  extraParams: Record<string, unknown>;
}

export interface GeneratedImage {
  /** 上游临时链接。必须在 limits.resultUrlTtlSeconds 内转存 */
  url?: string;
  /** 上游直接返回的 base64(不含 data URI 前缀) */
  base64?: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface ProviderFailure {
  kind: 'failed';
  errorCode: ErrorCode;
  /** 已由 sanitizeUpstreamMessage 脱敏,可安全写库与写日志 */
  message: string;
  retryable: boolean;
  httpStatus?: number;
  providerTaskId?: string;
  retryAfterSeconds?: number;
}

export interface ImageCompleted {
  kind: 'completed';
  images: GeneratedImage[];
  upstreamDurationMs: number;
  providerTaskId?: string;
  /**
   * 上游返回的真实进度百分比(可选)。
   * 契约中当前没有这个字段——Worker 只在它确实存在且为合法数值时才写库,
   * 绝不由 Worker 自己推算,避免伪造进度(docs/CONVENTIONS.md §11)。
   */
  progressPercent?: number;
}

export interface ImagePending {
  kind: 'pending';
  providerTaskId: string;
  pollAfterMs?: number;
  /** 同上:仅当上游真的给出百分比时才有值 */
  progressPercent?: number;
}

export type ImageGenerationOutcome = ImageCompleted | ImagePending | ProviderFailure;
export type PollOutcome = ImageGenerationOutcome;

export interface ModelDescriptor {
  modelKey: string;
  displayName: string;
  capabilities: Array<'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'TEXT'>;
  limits: ModelLimits;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  httpStatus?: number;
  latencyMs: number;
  errorCode?: ErrorCode;
}

export interface ImageProvider {
  readonly kind: ProviderKindValue;
  submit(
    req: ImageGenerationRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<ImageGenerationOutcome>;
  poll?(
    providerTaskId: string,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<PollOutcome>;
  describeDefaultModels(): ModelDescriptor[];
  testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult>;
}

export interface StructuredTextRequest {
  modelKey: string;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens?: number;
  schemaName?: string;
  temperature?: number;
}

export interface TextCompleted {
  kind: 'completed';
  /** 上游原始字符串,不可直接信任 */
  raw: string;
  /** 仅表示"语法是合法 JSON",结构校验必须由上层用 zod 完成 */
  parsed: unknown;
  upstreamDurationMs: number;
  finishReason?: string;
}

export type StructuredTextOutcome = TextCompleted | ProviderFailure;

export interface TextProvider {
  readonly kind: ProviderKindValue;
  generateStructured(
    req: StructuredTextRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<StructuredTextOutcome>;
  describeDefaultModels(): ModelDescriptor[];
  testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult>;
}

export function isFailure(
  outcome: ImageGenerationOutcome | StructuredTextOutcome,
): outcome is ProviderFailure {
  return outcome.kind === 'failed';
}
