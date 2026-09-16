/**
 * @june/providers:AI 模型供应商适配层。
 *
 * 这个包只做一件事:把各家形态不一的接口翻译成 @june/shared 定义的统一契约。
 * 它不含队列、不含重试策略、不含配额判断 —— 那些属于上层 Worker。
 *
 * 使用顺序:
 *  1. 后台配置模型时用 describeDefaultModels() 拿到官方文档核对过的 limits;
 *  2. 上层用 @june/shared 的 countUpstreamCalls(count, limits) 决定拆几次调用;
 *  3. 每次调用 getImageProvider(kind).submit(...);
 *  4. 若返回 pending,按 pollAfterMs 调用 poll(...);
 *  5. 拿到 completed 后立刻转存图片(注意 limits.resultUrlTtlSeconds,
 *     FLUX 只有 10 分钟,OpenAI dall-e 60 分钟,Ark / 万相 24 小时);
 *  6. 文本结果只信 raw,用 copyResultPayloadSchema 校验 parsed。
 *
 * 安全约定:任何时候都不要把 ProviderCredentials 写进日志。
 * 需要输出上游错误时使用 sanitizeUpstreamMessage。
 */

// 统一抽象
export * from './types';

// HTTP 与失败分类
export {
  DEFAULT_TIMEOUT_MS,
  classifyHttpFailure,
  classifyTransportFailure,
  contentBlockedFailure,
  failureToErrorCode,
  httpCall,
  malformedResponse,
  parseRetryAfterSeconds,
  unknownResult,
  type CallPhase,
  type HttpMethod,
  type HttpOutcome,
  type HttpRequestSpec,
  type HttpResponse,
  type TransportError,
  type TransportErrorCause,
} from './http';

// 脱敏
export { MAX_MESSAGE_CHARS, formatUpstreamMessage, sanitizeUpstreamMessage } from './sanitize';

// limits 助手
export { buildLimits, parseSizeString, readBoolean, readEnum, readInt, toBase64, type ModelLimitsInput } from './limits';

// 生图适配器
export {
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_QUALITY_VALUES,
  OpenAiImageProvider,
  buildEditFormData,
  buildGenerationBody,
  describeOpenAiImageModels,
  extractOpenAiError,
  isGptImageModel,
  parseImagesResponse,
  trimTrailingSlash,
  type OpenAiGenerationBody,
  type ParsedOpenAiImages,
} from './image/openai';

export {
  GEMINI_ASPECT_RATIOS,
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_IMAGE_SIZES,
  GeminiImageProvider,
  buildInteractionBody,
  describeGeminiImageModels,
  extractGeminiError,
  parseInteractionResponse,
  type GeminiInputBlock,
  type GeminiInteractionBody,
  type GeminiResponseFormat,
  type ParsedGeminiImages,
} from './image/gemini';

export {
  ARK_DEFAULT_BASE_URL,
  ARK_MAX_IMAGES_HARD_CAP,
  ARK_SIZE_TIERS,
  ArkSeedreamImageProvider,
  buildArkBody,
  clampArkMaxImages,
  describeArkImageModels,
  extractArkError,
  parseArkResponse,
  toArkDataUri,
  type ArkGenerationBody,
  type ParsedArkResponse,
} from './image/ark-seedream';

export {
  AliyunWanxImageProvider,
  WANX_DEFAULT_BASE_URL,
  WANX_POLL_INTERVAL_MS,
  WANX_TASK_STATUSES,
  buildWanxSubmitBody,
  clampWanxCount,
  describeWanxImageModels,
  extractWanxError,
  mapWanxPollResult,
  parseWanxPollResponse,
  parseWanxSubmitResponse,
  toWanxSize,
  type WanxPollResult,
  type WanxSubmitBody,
  type WanxSubmitResult,
  type WanxTaskStatus,
} from './image/aliyun-wanx';

export {
  BFL_DEFAULT_BASE_URL,
  BFL_MAX_INPUT_IMAGES,
  BFL_POLL_INTERVAL_MS,
  BFL_STATUSES,
  BflFluxImageProvider,
  buildBflSubmitBody,
  buildBflSubmitUrl,
  describeBflImageModels,
  extractBflError,
  mapBflPollResult,
  parseBflPollResponse,
  parseBflSubmitResponse,
  resolveBflDimensions,
  type BflPollResult,
  type BflStatus,
  type BflSubmitBody,
  type BflSubmitResult,
} from './image/bfl-flux';

export {
  MOCK_DEFAULT_CONFIG,
  MockImageProvider,
  clampMockDelayMs,
  createMockPng,
  describeMockImageModels,
  type MockProviderConfig,
} from './image/mock';

// 文本适配器
export {
  OpenAiCompatibleTextProvider,
  buildChatCompletionBody,
  describeOpenAiCompatibleTextModels,
  describeOpenAiTextModels,
  finalizeStructuredText,
  parseChatCompletionResponse,
  type ChatCompletionBody,
  type ChatCompletionMessage,
  type ParsedChatCompletion,
} from './text/openai-compatible';

export {
  GeminiTextProvider,
  buildGeminiTextBody,
  describeGeminiTextModels,
  normalizeGeminiFinishReason,
  parseGeminiTextResponse,
  type GeminiTextBody,
  type ParsedGeminiText,
} from './text/gemini-text';

// 注册表
export {
  ProviderNotImplementedError,
  UnknownProviderError,
  createMockImageProvider,
  describeAllDefaultModels,
  getImageProvider,
  getTextProvider,
} from './registry';
