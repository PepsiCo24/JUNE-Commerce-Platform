/**
 * Google Gemini(Generative Language API)图像生成适配器 —— Nano Banana 系列。
 *
 * 核对来源(官方):
 *  - https://ai.google.dev/gemini-api/docs/image-generation (最后更新 2026-09-08)
 *  - https://ai.google.dev/gemini-api/docs/interactions-overview (最后更新 2026-09-04)
 * 核对日期:2026-09-16
 *
 * 形态:**同步**。单次 POST 直接返回 base64 图片,无轮询。
 *
 * 重要的协议现状(与常见预期不同,已核对):
 *  Gemini 的图像生成**不是** OpenAI 那样的 /images 端点,而是走 Gemini 自己的多模态端点。
 *  官方文档目前只给出 **Interactions API** 形态:
 *      POST https://generativelanguage.googleapis.com/v1beta/interactions
 *  官方同时说明:旧的 `:generateContent` 形态「仍然完全受支持(fully supported)」,
 *  但 image-generation 文档页已不再提供 generateContent 的 REST 示例。
 *  因此本适配器实现 **interactions** 形态(唯一有官方 REST 示例可核对的形态)。
 *
 * 文档明确的字段(已核对):
 *  - 端点:POST {baseUrl}/interactions,Content-Type: application/json
 *  - 认证:请求头 `x-goog-api-key: <apiKey>`(不是 Authorization: Bearer)
 *  - 请求体:{ model, input, response_format?, generation_config?, tools?, previous_interaction_id? }
 *  - input 可为字符串,或内容块数组:
 *      { type: 'text', text }
 *      { type: 'image', mime_type, data }   // data 为 base64,无 data URI 前缀
 *  - response_format(type = 'image')支持 mime_type / aspect_ratio / image_size
 *  - image_size 取值必须大写 K:512px(0.5K) / 1K / 2K / 4K;小写(如 1k)会被拒绝
 *  - 支持的宽高比与对应像素(1K 档):1:1=1024x1024、1:4=512x2048、1:8=384x3072、
 *      2:3=848x1264、3:2=1264x848、3:4=896x1200、4:1=2048x512、4:3=1200x896、
 *      4:5=928x1152、5:4=1152x928、8:1=3072x384、9:16=768x1376、16:9=1376x768、21:9=1584x672
 *  - 参考图最多 14 张(gemini-3.1-flash-image / gemini-3-pro-image);
 *    gemini-2.5-flash-image 最多 3 张
 *  - gemini-3.1-flash-lite-image 仅支持 1K 分辨率
 *  - 结果载体:base64(文档示例统一用 base64.b64decode 落盘)
 *  - 文档明确:「模型不一定会生成用户明确要求的确切数量的图片输出」,
 *    且请求体没有 n / count 参数 => 单次调用按 1 张处理,批量由上层拆分
 *
 * 待真实联调(文档未 100% 确认,因此本文件所有模型 limits.verified = false):
 *  - **响应 JSON 的确切字段名**。官方 REST 示例只给了请求侧;响应侧仅在 Python/JS SDK
 *    示例中以属性形式出现(interaction.id、interaction.output_image.data、
 *    interaction.steps[].type === 'model_output'、step.content[].type === 'image')。
 *    官方文档未展示原始 JSON 响应体,故 snake_case 字段名(output_image / mime_type /
 *    steps / content)属于合理推断而非文档确认。parseInteractionResponse 已做多路兼容
 *    (output_image、steps[].content[]、candidates[].content.parts[] 三种形态),
 *    首次联调必须打一次真实响应确认。
 *  - **错误响应体结构**未在该文档页给出;当前按 Google API 常见的
 *    { error: { code, message, status } } 解析,解析不到则回退到原始文本(已脱敏)。
 *  - **限流响应头**是否为标准 Retry-After 未在文档中说明,已交由通用 classifyHttpFailure
 *    处理(解析不到则由上层退避)。
 *  - **negative prompt**:文档建议用「语义负面提示」写在正向 prompt 里,
 *    没有独立参数 => supportsNegativePrompt = false。
 *  - **seed**:请求体无 seed 参数 => supportsSeed = false。
 *  - **参考图单张字节上限**未在该页给出数值。
 */

import { ERROR_CODES } from '@june/shared';

import {
  classifyHttpFailure,
  classifyTransportFailure,
  httpCall,
  malformedResponse,
  type CallPhase,
} from '../http';
import { buildLimits, readEnum, toBase64 } from '../limits';
import { sanitizeUpstreamMessage } from '../sanitize';
import type {
  ConnectionTestResult,
  GeneratedImage,
  ImageGenerationOutcome,
  ImageGenerationRequest,
  ImageProvider,
  ModelDescriptor,
  ProviderCallOptions,
  ProviderCredentials,
} from '../types';
import { trimTrailingSlash } from './openai';

const PROVIDER_LABEL = 'Gemini';
const DOCS_URL = 'https://ai.google.dev/gemini-api/docs/image-generation';
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** 文档表格中列出的全部宽高比 */
export const GEMINI_ASPECT_RATIOS = [
  '1:1',
  '1:4',
  '1:8',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '21:9',
] as const;

/** 文档明确:必须大写 K,小写会被拒绝 */
export const GEMINI_IMAGE_SIZES = ['512px', '1K', '2K', '4K'] as const;

// ---------------------------------------------------------------------------
// 请求体构造
// ---------------------------------------------------------------------------

export type GeminiInputBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mime_type: string; data: string };

export interface GeminiResponseFormat {
  type: 'image';
  mime_type?: string;
  aspect_ratio?: string;
  image_size?: string;
}

export interface GeminiInteractionBody {
  model: string;
  input: GeminiInputBlock[];
  response_format: GeminiResponseFormat;
  /** 仅 gemini-3.1-flash-image 支持,取值 minimal | high */
  generation_config?: { thinking_level: string };
  /** 默认不落库,减少数据留存面 */
  store: boolean;
}

export function buildInteractionBody(req: ImageGenerationRequest): GeminiInteractionBody {
  const input: GeminiInputBlock[] = [{ type: 'text', text: req.prompt }];
  for (const ref of req.referenceImages ?? []) {
    input.push({ type: 'image', mime_type: ref.mimeType, data: toBase64(ref.data) });
  }

  const responseFormat: GeminiResponseFormat = { type: 'image' };

  const mimeType = readEnum(req.extraParams, 'mime_type', ['image/png', 'image/jpeg'] as const, 'image/png');
  if (mimeType) responseFormat.mime_type = mimeType;

  if (req.aspectRatio && (GEMINI_ASPECT_RATIOS as readonly string[]).includes(req.aspectRatio)) {
    responseFormat.aspect_ratio = req.aspectRatio;
  }

  const imageSize = readEnum(req.extraParams, 'image_size', GEMINI_IMAGE_SIZES, undefined);
  if (imageSize) responseFormat.image_size = imageSize;

  const body: GeminiInteractionBody = {
    model: req.modelKey,
    input,
    response_format: responseFormat,
    // store=false 走无状态模式:本平台不使用 previous_interaction_id 多轮能力,
    // 关闭服务端留存可减少商品图/参考图在上游的驻留时间。
    store: false,
  };

  const thinkingLevel = readEnum(req.extraParams, 'thinking_level', ['minimal', 'high'] as const, undefined);
  if (thinkingLevel) {
    body.generation_config = { thinking_level: thinkingLevel };
  }

  return body;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

export interface ParsedGeminiImages {
  images: GeneratedImage[];
  interactionId?: string;
}

/**
 * 解析 interactions 响应。
 *
 * 待真实联调:官方文档未给出原始 JSON 响应体,以下三种形态按优先级依次尝试:
 *  1. output_image: { data, mime_type }            —— 对应 SDK 的 interaction.output_image
 *  2. steps[].content[] 中 type === 'image' 的块   —— 对应 SDK 的 interaction.steps 遍历
 *  3. candidates[].content.parts[].inline_data     —— 兼容 generateContent 旧形态
 * 首次联调后应删掉未命中的分支,只保留真实形态。
 */
export function parseInteractionResponse(payload: unknown): ParsedGeminiImages | { error: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: '响应不是 JSON 对象' };
  }
  const root = payload as Record<string, unknown>;
  const interactionId = typeof root['id'] === 'string' ? (root['id'] as string) : undefined;
  const images: GeneratedImage[] = [];

  // 形态 1:便捷属性 output_image
  const outputImage = root['output_image'];
  pushImageBlock(outputImage, images);

  // 形态 2:steps[].content[]
  if (images.length === 0 && Array.isArray(root['steps'])) {
    for (const step of root['steps'] as unknown[]) {
      if (typeof step !== 'object' || step === null) continue;
      const stepObj = step as Record<string, unknown>;
      if (stepObj['type'] !== 'model_output') continue;
      const content = stepObj['content'];
      if (!Array.isArray(content)) continue;
      for (const block of content as unknown[]) {
        pushImageBlock(block, images);
      }
    }
  }

  // 形态 3:generateContent 旧形态的 candidates[].content.parts[].inline_data
  if (images.length === 0 && Array.isArray(root['candidates'])) {
    for (const candidate of root['candidates'] as unknown[]) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const content = (candidate as Record<string, unknown>)['content'];
      if (typeof content !== 'object' || content === null) continue;
      const parts = (content as Record<string, unknown>)['parts'];
      if (!Array.isArray(parts)) continue;
      for (const part of parts as unknown[]) {
        if (typeof part !== 'object' || part === null) continue;
        const inline = (part as Record<string, unknown>)['inline_data'] ?? (part as Record<string, unknown>)['inlineData'];
        if (typeof inline !== 'object' || inline === null) continue;
        const inlineObj = inline as Record<string, unknown>;
        const data = inlineObj['data'];
        if (typeof data !== 'string' || data.length === 0) continue;
        const mime = inlineObj['mime_type'] ?? inlineObj['mimeType'];
        images.push({ base64: data, mimeType: typeof mime === 'string' ? mime : 'image/png' });
      }
    }
  }

  if (images.length === 0) {
    return { error: '响应中未找到图片内容块(已尝试 output_image / steps / candidates 三种形态)' };
  }
  return { images, ...(interactionId ? { interactionId } : {}) };
}

function pushImageBlock(block: unknown, out: GeneratedImage[]): void {
  if (typeof block !== 'object' || block === null) return;
  const obj = block as Record<string, unknown>;
  // steps 内的块带 type 字段;output_image 便捷属性没有
  if ('type' in obj && obj['type'] !== 'image') return;
  const data = obj['data'];
  if (typeof data !== 'string' || data.length === 0) return;
  const mime = obj['mime_type'] ?? obj['mimeType'];
  out.push({ base64: data, mimeType: typeof mime === 'string' ? mime : 'image/png' });
}

/**
 * 抽取 Google API 错误体。
 * 待真实联调:image-generation 文档页未给出错误体结构,这里按 Google API 通用形态
 * { error: { code, status, message } } 解析,失败则回退到脱敏后的原文。
 */
export function extractGeminiError(payload: unknown): { detail: string; structured: boolean } {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as Record<string, unknown>)['error'];
    if (typeof error === 'object' && error !== null) {
      const e = error as Record<string, unknown>;
      const parts = [e['status'], e['message']].filter((v): v is string => typeof v === 'string');
      if (parts.length > 0) return { detail: parts.join(' / '), structured: true };
    }
  }
  return { detail: sanitizeUpstreamMessage(payload), structured: false };
}

// ---------------------------------------------------------------------------
// 模型能力
// ---------------------------------------------------------------------------

function geminiImageLimits(overrides: { maxReferenceImages: number }): ReturnType<typeof buildLimits> {
  return buildLimits({
    // 请求体无 n 参数,且文档明确「不保证生成确切数量」=> 单次按 1 张
    maxOutputs: 1,
    maxOutputsPerCall: 1,
    maxReferenceImages: overrides.maxReferenceImages,
    // 待真实联调:文档未给出参考图单张字节上限,先沿用平台默认(0)
    maxReferenceBytes: 0,
    sizes: [],
    aspectRatios: [...GEMINI_ASPECT_RATIOS],
    sizeMode: 'aspect_ratio',
    deliveryMode: 'sync',
    resultCarrier: 'base64',
    supportsNegativePrompt: false,
    supportsSeed: false,
    supportsImageEdit: overrides.maxReferenceImages > 0,
    // 待真实联调:文档未给出图像生成的 prompt 字符上限,沿用平台默认(0)
    maxPromptChars: 0,
    resultUrlTtlSeconds: 0,
    docsUrl: DOCS_URL,
    // 响应体字段名未经官方 REST 文档确认 => 一律标记未核对
    verified: false,
  });
}

export function describeGeminiImageModels(): ModelDescriptor[] {
  return [
    {
      modelKey: 'gemini-3.1-flash-image',
      displayName: 'Gemini 3.1 Flash Image (Nano Banana 2)',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: geminiImageLimits({ maxReferenceImages: 14 }),
    },
    {
      modelKey: 'gemini-3-pro-image',
      displayName: 'Gemini 3 Pro Image (Nano Banana Pro)',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: geminiImageLimits({ maxReferenceImages: 14 }),
    },
    {
      modelKey: 'gemini-2.5-flash-image',
      displayName: 'Gemini 2.5 Flash Image (Nano Banana)',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      // 文档明确:gemini-2.5-flash-image 最多接受 3 张输入图片
      limits: geminiImageLimits({ maxReferenceImages: 3 }),
    },
  ];
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export class GeminiImageProvider implements ImageProvider {
  readonly kind = 'GEMINI' as const;

  describeDefaultModels(): ModelDescriptor[] {
    return describeGeminiImageModels();
  }

  async submit(
    req: ImageGenerationRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<ImageGenerationOutcome> {
    const phase: CallPhase = 'submit';
    const baseUrl = trimTrailingSlash(creds.baseUrl || GEMINI_DEFAULT_BASE_URL);

    const outcome = await httpCall({
      url: `${baseUrl}/interactions`,
      method: 'POST',
      headers: {
        'x-goog-api-key': creds.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      json: buildInteractionBody(req),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return classifyTransportFailure(phase, PROVIDER_LABEL, outcome.transport);
    }

    const { response, durationMs } = outcome;
    if (response.status < 200 || response.status >= 300) {
      const { detail, structured } = extractGeminiError(response.json ?? response.bodyText);
      return classifyHttpFailure({
        phase,
        providerLabel: PROVIDER_LABEL,
        response,
        upstreamDetail: detail,
        hasStructuredError: structured,
      });
    }

    const parsed = parseInteractionResponse(response.json);
    if ('error' in parsed) {
      return malformedResponse(PROVIDER_LABEL, parsed.error, response.status);
    }
    return {
      kind: 'completed',
      images: parsed.images,
      upstreamDurationMs: durationMs,
      ...(parsed.interactionId ? { providerTaskId: parsed.interactionId } : {}),
    };
  }

  async testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult> {
    // GET /models 是只读列表接口,不产生生成费用
    const baseUrl = trimTrailingSlash(creds.baseUrl || GEMINI_DEFAULT_BASE_URL);
    const outcome = await httpCall({
      url: `${baseUrl}/models`,
      method: 'GET',
      headers: { 'x-goog-api-key': creds.apiKey, accept: 'application/json' },
      timeoutMs: options?.timeoutMs ?? 15_000,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return {
        ok: false,
        message: sanitizeUpstreamMessage(outcome.transport.detail),
        latencyMs: outcome.durationMs,
        errorCode: ERROR_CODES.UPSTREAM_TIMEOUT,
      };
    }
    const ok = outcome.response.status >= 200 && outcome.response.status < 300;
    return {
      ok,
      message: ok ? '连接正常' : sanitizeUpstreamMessage(extractGeminiError(outcome.response.json).detail),
      httpStatus: outcome.response.status,
      latencyMs: outcome.durationMs,
      ...(ok ? {} : { errorCode: ERROR_CODES.UPSTREAM_ERROR }),
    };
  }
}
