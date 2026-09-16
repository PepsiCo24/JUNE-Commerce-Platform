/**
 * OpenAI 图像生成适配器。
 *
 * 核对来源(官方):
 *  - OpenAI 官方 OpenAPI 规范仓库 https://github.com/openai/openai-openapi
 *    (raw: https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml)
 *    —— 使用 CreateImageRequest / CreateImageEditRequest / ImagesResponse / Image / Error 定义
 *  - API 参考首页 https://platform.openai.com/docs/api-reference/images
 *    (该站点有反爬拦截,本次通过 OpenAI 自家 OpenAPI 规范核对,规范与 API 参考同源)
 * 核对日期:2026-09-16
 *
 * 形态:**同步**。POST 后在同一响应里直接返回图片,无需轮询。
 *
 * 文档明确的字段(已核对):
 *  - 端点:POST {baseUrl}/images/generations(JSON)、POST {baseUrl}/images/edits(multipart/form-data)
 *  - 认证:Authorization: Bearer <apiKey>
 *  - n:整数 1~10;dall-e-3 仅支持 n = 1
 *  - size:标准值 1024x1024 / 1536x1024 / 1024x1536(GPT image 系列);
 *          dall-e-2 为 256x256 / 512x512 / 1024x1024;dall-e-3 为 1024x1024 / 1792x1024 / 1024x1792;
 *          gpt-image-2 及 2.5 系列额外支持任意 WIDTHxHEIGHT(宽高均须为 16 的整数倍,
 *          宽高比在 1:3 ~ 3:1 之间,最大 3840x2160)
 *  - response_format:url | b64_json,**仅对 dall-e-2 / dall-e-3 有效**;
 *                    GPT image 系列恒定返回 base64(Image.b64_json)
 *  - url 有效期:生成后 60 分钟(=> resultUrlTtlSeconds 3600)
 *  - prompt 长度:GPT image 系列 32000 字符;dall-e-2 1000;dall-e-3 4000
 *  - images/edits:image 支持单个文件或最多 16 个文件;GPT image 系列每张 < 50MB(png/webp/jpg);
 *                 dall-e-2 仅 1 张、正方形 png、< 4MB
 *  - 响应:{ created, data: [{ b64_json?, url?, revised_prompt? }], size?, output_format?, quality?, usage? }
 *  - 错误体:{ error: { code, message, param, type } }
 *
 * 待真实联调(文档未 100% 确认的部分):
 *  - 无 seed 参数:CreateImageRequest 中不存在 seed 字段 => limits.supportsSeed = false。
 *    若后续 OpenAI 增补,需要同步放开。
 *  - 无 negative_prompt 参数 => limits.supportsNegativePrompt = false。
 *  - 参考图单张字节上限 50MB 来自文档描述文本,未在 schema 中以数值形式约束;
 *    平台侧仍以自身 FILE_TOO_LARGE 阈值为准。
 */

import { ERROR_CODES } from '@june/shared';

import {
  classifyHttpFailure,
  classifyTransportFailure,
  httpCall,
  malformedResponse,
  type CallPhase,
} from '../http';
import { buildLimits, parseSizeString, readEnum } from '../limits';
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

const PROVIDER_LABEL = 'OpenAI';
const DOCS_URL = 'https://platform.openai.com/docs/api-reference/images';
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** GPT image 系列恒定返回 base64;dall-e 系列默认返回 url */
const GPT_IMAGE_MODEL_PREFIX = 'gpt-image';

export function isGptImageModel(modelKey: string): boolean {
  return modelKey.startsWith(GPT_IMAGE_MODEL_PREFIX) || modelKey === 'chatgpt-image-latest';
}

// ---------------------------------------------------------------------------
// 请求体构造(纯函数,便于单测)
// ---------------------------------------------------------------------------

export interface OpenAiGenerationBody {
  model: string;
  prompt: string;
  n: number;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  moderation?: string;
  style?: string;
  response_format?: string;
  user?: string;
}

/**
 * 构造 /images/generations 的 JSON body。
 * 注意:适配器只发一次调用,n 直接取 req.count(上层已按 maxOutputsPerCall 拆分)。
 */
export function buildGenerationBody(req: ImageGenerationRequest): OpenAiGenerationBody {
  const body: OpenAiGenerationBody = {
    model: req.modelKey,
    prompt: req.prompt,
    n: req.count,
  };

  const size = resolveSize(req);
  if (size) body.size = size;

  // 以下均为文档明确的可选参数,只接受白名单取值,未识别的 extraParams 一律忽略
  const quality = readEnum(
    req.extraParams,
    'quality',
    ['standard', 'hd', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const,
    undefined,
  );
  if (quality) body.quality = quality;

  const background = readEnum(req.extraParams, 'background', ['transparent', 'opaque', 'auto'] as const, undefined);
  if (background) body.background = background;

  const outputFormat = readEnum(req.extraParams, 'output_format', ['png', 'jpeg', 'webp'] as const, undefined);
  if (outputFormat) body.output_format = outputFormat;

  const moderation = readEnum(req.extraParams, 'moderation', ['low', 'auto'] as const, undefined);
  if (moderation) body.moderation = moderation;

  // style 仅 dall-e-3 支持
  if (req.modelKey === 'dall-e-3') {
    const style = readEnum(req.extraParams, 'style', ['vivid', 'natural'] as const, undefined);
    if (style) body.style = style;
  }

  // response_format 仅 dall-e-2 / dall-e-3 支持;对 GPT image 系列传入会被拒绝,故不传
  if (!isGptImageModel(req.modelKey)) {
    body.response_format = readEnum(req.extraParams, 'response_format', ['url', 'b64_json'] as const, 'b64_json');
  }

  const user = req.extraParams['user'];
  if (typeof user === 'string' && user.length > 0 && user.length <= 256) {
    body.user = user;
  }

  return body;
}

/**
 * 构造 /images/edits 的 multipart/form-data。
 * 文档要求 image 为文件字段;多张参考图时重复使用同名字段 image[]。
 *
 * 待真实联调:多图时字段名的确切写法。OpenAPI 规范把 image 声明为
 * `binary | array<binary>`,但未规定 multipart 里数组字段的序列化方式。
 * 这里采用 `image[]` 重复字段(官方 SDK 的常见做法);首次联调需验证,
 * 若被拒绝则改为重复的 `image` 字段名。
 */
export function buildEditFormData(req: ImageGenerationRequest): FormData {
  const form = new FormData();
  form.set('model', req.modelKey);
  form.set('prompt', req.prompt);
  form.set('n', String(req.count));

  const size = resolveSize(req);
  if (size) form.set('size', size);

  const quality = readEnum(
    req.extraParams,
    'quality',
    ['standard', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const,
    undefined,
  );
  if (quality) form.set('quality', quality);

  const background = readEnum(req.extraParams, 'background', ['transparent', 'opaque', 'auto'] as const, undefined);
  if (background) form.set('background', background);

  const outputFormat = readEnum(req.extraParams, 'output_format', ['png', 'jpeg', 'webp'] as const, undefined);
  if (outputFormat) form.set('output_format', outputFormat);

  if (!isGptImageModel(req.modelKey)) {
    form.set('response_format', readEnum(req.extraParams, 'response_format', ['url', 'b64_json'] as const, 'b64_json') as string);
  }

  const references = req.referenceImages ?? [];
  const multiple = references.length > 1;
  references.forEach((ref, index) => {
    const blob = new Blob([toArrayBufferView(ref.data)], { type: ref.mimeType });
    const filename = `reference-${index}.${extensionFor(ref.mimeType)}`;
    form.append(multiple ? 'image[]' : 'image', blob, filename);
  });

  return form;
}

function toArrayBufferView(data: Buffer | Uint8Array): Uint8Array {
  return Buffer.isBuffer(data) ? new Uint8Array(data) : data;
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

/** 优先用 size 字符串;若模型走 width_height 模式则拼成 WIDTHxHEIGHT */
function resolveSize(req: ImageGenerationRequest): string | undefined {
  if (req.size) return req.size;
  if (req.width && req.height) return `${req.width}x${req.height}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// 响应解析(纯函数,便于单测)
// ---------------------------------------------------------------------------

export interface ParsedOpenAiImages {
  images: GeneratedImage[];
  /** 上游回报的实际尺寸,用于回填 width/height */
  size?: string;
}

/**
 * 解析 ImagesResponse。
 * data[].b64_json 与 data[].url 二者其一;mimeType 由顶层 output_format 推断,缺省 png。
 */
export function parseImagesResponse(payload: unknown): ParsedOpenAiImages | { error: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: '响应不是 JSON 对象' };
  }
  const root = payload as Record<string, unknown>;
  const data = root['data'];
  if (!Array.isArray(data) || data.length === 0) {
    return { error: '响应缺少 data 数组' };
  }

  const outputFormat = typeof root['output_format'] === 'string' ? (root['output_format'] as string) : 'png';
  const mimeType = `image/${outputFormat === 'jpg' ? 'jpeg' : outputFormat}`;
  const sizeString = typeof root['size'] === 'string' ? (root['size'] as string) : undefined;
  const dims = parseSizeString(sizeString);

  const images: GeneratedImage[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const base64 = typeof item['b64_json'] === 'string' ? (item['b64_json'] as string) : undefined;
    const url = typeof item['url'] === 'string' ? (item['url'] as string) : undefined;
    if (!base64 && !url) continue;
    images.push({
      ...(base64 ? { base64 } : {}),
      ...(url ? { url } : {}),
      mimeType,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    });
  }

  if (images.length === 0) {
    return { error: 'data 数组中没有可用的 b64_json 或 url' };
  }
  return { images, ...(sizeString ? { size: sizeString } : {}) };
}

/** 抽取 OpenAI 标准错误体 { error: { code, message, param, type } } */
export function extractOpenAiError(payload: unknown): { detail: string; structured: boolean } {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as Record<string, unknown>)['error'];
    if (typeof error === 'object' && error !== null) {
      const e = error as Record<string, unknown>;
      const parts = [e['type'], e['code'], e['message']].filter((v): v is string => typeof v === 'string');
      if (parts.length > 0) {
        return { detail: parts.join(' / '), structured: true };
      }
    }
  }
  return { detail: sanitizeUpstreamMessage(payload), structured: false };
}

// ---------------------------------------------------------------------------
// 模型能力
// ---------------------------------------------------------------------------

const GPT_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'];

function gptImageLimits(): ReturnType<typeof buildLimits> {
  return buildLimits({
    maxOutputs: 10,
    maxOutputsPerCall: 10,
    maxReferenceImages: 16,
    maxReferenceBytes: 50 * 1024 * 1024,
    sizes: GPT_IMAGE_SIZES,
    sizeMode: 'size_string',
    deliveryMode: 'sync',
    // GPT image 系列恒定返回 base64,不受 response_format 影响
    resultCarrier: 'base64',
    supportsNegativePrompt: false,
    supportsSeed: false,
    supportsImageEdit: true,
    maxPromptChars: 32_000,
    // base64 载体没有链接过期问题
    resultUrlTtlSeconds: 0,
    docsUrl: DOCS_URL,
    verified: true,
  });
}

export function describeOpenAiImageModels(): ModelDescriptor[] {
  return [
    {
      modelKey: 'gpt-image-1.5',
      displayName: 'OpenAI GPT Image 1.5',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: gptImageLimits(),
    },
    {
      modelKey: 'gpt-image-1',
      displayName: 'OpenAI GPT Image 1',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: gptImageLimits(),
    },
    {
      modelKey: 'dall-e-3',
      displayName: 'OpenAI DALL·E 3',
      capabilities: ['TEXT_TO_IMAGE'],
      limits: buildLimits({
        // 文档明确:dall-e-3 仅支持 n = 1
        maxOutputs: 1,
        maxOutputsPerCall: 1,
        maxReferenceImages: 0,
        sizes: ['1024x1024', '1792x1024', '1024x1792'],
        sizeMode: 'size_string',
        deliveryMode: 'sync',
        // 适配器默认请求 b64_json;若后台改回 url,链接 60 分钟过期
        resultCarrier: 'base64',
        supportsNegativePrompt: false,
        supportsSeed: false,
        supportsImageEdit: false,
        maxPromptChars: 4_000,
        resultUrlTtlSeconds: 3_600,
        docsUrl: DOCS_URL,
        verified: true,
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export class OpenAiImageProvider implements ImageProvider {
  readonly kind = 'OPENAI' as const;

  describeDefaultModels(): ModelDescriptor[] {
    return describeOpenAiImageModels();
  }

  async submit(
    req: ImageGenerationRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<ImageGenerationOutcome> {
    const phase: CallPhase = 'submit';
    const isEdit = (req.referenceImages ?? []).length > 0;
    const baseUrl = trimTrailingSlash(creds.baseUrl || OPENAI_DEFAULT_BASE_URL);
    const url = `${baseUrl}${isEdit ? '/images/edits' : '/images/generations'}`;

    const outcome = await httpCall({
      url,
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        accept: 'application/json',
        // multipart 的 Content-Type(含 boundary)由 undici 依据 FormData 自动设置
        ...(isEdit ? {} : { 'content-type': 'application/json' }),
      },
      ...(isEdit ? { formData: buildEditFormData(req) } : { json: buildGenerationBody(req) }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return classifyTransportFailure(phase, PROVIDER_LABEL, outcome.transport);
    }

    const { response, durationMs } = outcome;
    if (response.status < 200 || response.status >= 300) {
      const { detail, structured } = extractOpenAiError(response.json ?? response.bodyText);
      return classifyHttpFailure({
        phase,
        providerLabel: PROVIDER_LABEL,
        response,
        upstreamDetail: detail,
        hasStructuredError: structured,
      });
    }

    const parsed = parseImagesResponse(response.json);
    if ('error' in parsed) {
      return malformedResponse(PROVIDER_LABEL, parsed.error, response.status);
    }
    return { kind: 'completed', images: parsed.images, upstreamDurationMs: durationMs };
  }

  async testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult> {
    // 用 GET /models 做连通性与鉴权探测:只读、不产生生成费用
    const baseUrl = trimTrailingSlash(creds.baseUrl || OPENAI_DEFAULT_BASE_URL);
    const outcome = await httpCall({
      url: `${baseUrl}/models`,
      method: 'GET',
      headers: { authorization: `Bearer ${creds.apiKey}`, accept: 'application/json' },
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
      message: ok ? '连接正常' : sanitizeUpstreamMessage(extractOpenAiError(outcome.response.json).detail),
      httpStatus: outcome.response.status,
      latencyMs: outcome.durationMs,
      ...(ok ? {} : { errorCode: ERROR_CODES.UPSTREAM_ERROR }),
    };
  }
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** quality 白名单,供后台配置校验复用,避免在别处硬编码 */
export const OPENAI_QUALITY_VALUES = ['standard', 'hd', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
