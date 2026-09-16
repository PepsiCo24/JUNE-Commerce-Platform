/**
 * 火山方舟(Volcengine Ark)Seedream 图片生成适配器。
 *
 * 核对来源(官方):
 *  - 火山方舟「图片生成 API」https://www.volcengine.com/docs/82379/1541523
 *    (页面最近更新时间:2026-09-09)
 * 核对日期:2026-09-16
 *
 * 形态:**同步**。POST 后在同一响应里返回 data 数组(url 或 b64_json),无轮询。
 *       另有 stream=true 的流式形态,本适配器不使用(平台按整张图落库)。
 *
 * 国内域名与鉴权(已核对):
 *  - 端点:POST https://ark.cn-beijing.volces.com/api/v3/images/generations
 *    注意是国内域名 `ark.cn-beijing.volces.com`,路径前缀 `/api/v3`。
 *  - 认证:`Authorization: Bearer <ARK_API_KEY>`,API Key 从方舟控制台「API Key 管理」获取。
 *    文档同时支持用 Endpoint ID 代替 Model ID 调用以获得独立限流/计费能力。
 *
 * 文档明确的字段(已核对):
 *  - 请求体:model(必选)、prompt、image、size、output_format、response_format、
 *            sequential_image_generation、sequential_image_generation_options.max_images、
 *            watermark、background、layer_decomposition、stream、tools、optimize_prompt_options
 *  - image:string 或 string[],支持 **图片 URL** 或 **Base64**;
 *           Base64 必须是 `data:image/<小写格式>;base64,<编码>` 形式
 *  - 参考图上限:Seedream 5.0 pro 最多 10 张;Seedream 5.0 lite / 4.5 / 4.0 最多 14 张
 *  - 参考图单张:格式 jpeg/png/webp/bmp/tiff/gif/heic/heif;宽高比 [1/16, 16];
 *                边长 > 14px;**大小不超过 30MB**;总像素 [196, 6000x6000]
 *  - response_format:`url`(默认,**链接 24 小时内有效**)或 `b64_json`
 *  - output_format:png | jpeg(默认 jpeg)
 *  - watermark:**默认 true**(右下角「AI 生成」水印)。适配器默认显式传 false,
 *               避免因默认值给商品图打上水印;需要水印时由后台 extraParams 开启。
 *  - 出图张数:请求体**没有 n 参数**。
 *      · sequential_image_generation = 'disabled'(默认)→ 只生成 1 张;
 *      · = 'auto' → 组图模式,由模型自主判断张数,上限由
 *        sequential_image_generation_options.max_images 控制(取值 [1,15],默认 15),
 *        且「输入参考图数量 + 生成图片数量 ≤ 15」。
 *        组图仅 Seedream 5.0 lite / 4.5 / 4.0 支持,5.0 pro 不支持。
 *  - size:两种方式不可混用 —— 分辨率档位(如 5.0 pro:1K/1.5K/2K,默认 2K;
 *          4.0:1K/2K/4K)或宽高像素值 `宽x高`。
 *          5.0 pro 宽高方式总像素 [921600, 4624220]、宽高比 [1/16, 16];
 *          4.0 总像素 [921600, 16777216]、宽高比 [1/16, 16]。
 *  - 响应:{ model, created, data: [{ url? | b64_json?, size, output_format, error? }],
 *            usage: { generated_images, input_images?, output_tokens, total_tokens }, error? }
 *          组图场景单图失败时该条带 data[].error.{code,message},其余图不受影响。
 *  - 顶层 error:整个请求未产出任何图片时返回 error.{code,message}
 *
 * 待真实联调:
 *  - **Model ID**。文档正文只出现了一个可核对的完整 Model ID:`doubao-seedream-5-0-pro-260628`
 *    (见官方 cURL 示例)。Seedream 5.0 lite / 4.5 / 4.0 的完整带日期后缀的 Model ID
 *    未在该页给出,必须到方舟控制台「开通模型服务 / 查询 Model ID」确认后填入。
 *    因此除 5.0 pro 外,其余模型 limits.verified = false。
 *  - **prompt 长度**:文档给的是建议值(中文 ≤ 300 字、英文 ≤ 600 词),
 *    不是硬性上限 => maxPromptChars 保持 0(沿用平台默认),不冒充硬限制。
 *  - **negative_prompt**:请求体无该字段 => supportsNegativePrompt = false。
 *  - **seed**:请求体无该字段 => supportsSeed = false。
 *  - **限流响应头**:文档未说明 429 是否带标准 Retry-After,交由通用逻辑解析。
 *  - **错误码枚举**:文档指向单独的「错误码」页,本次未逐条核对,
 *    因此不按 code 做细分映射,统一按 HTTP 状态码分类。
 */

import { ERROR_CODES } from '@june/shared';

import {
  classifyHttpFailure,
  classifyTransportFailure,
  contentBlockedFailure,
  httpCall,
  malformedResponse,
  type CallPhase,
} from '../http';
import { buildLimits, parseSizeString, readBoolean, readEnum, readInt, toBase64 } from '../limits';
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

const PROVIDER_LABEL = '火山方舟 Seedream';
const DOCS_URL = 'https://www.volcengine.com/docs/82379/1541523';
export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/** 文档明确的分辨率档位。不同模型可选集合不同,取并集做白名单,越界由上游拒绝 */
export const ARK_SIZE_TIERS = ['1K', '1.5K', '2K', '3K', '4K', 'auto'] as const;

/** 组图上限:文档明确 max_images 取值 [1,15],且「参考图 + 生成图 ≤ 15」 */
export const ARK_MAX_IMAGES_HARD_CAP = 15;

// ---------------------------------------------------------------------------
// 请求体构造
// ---------------------------------------------------------------------------

export interface ArkGenerationBody {
  model: string;
  prompt: string;
  image?: string | string[];
  size?: string;
  output_format?: string;
  response_format: 'url' | 'b64_json';
  sequential_image_generation?: 'auto' | 'disabled';
  sequential_image_generation_options?: { max_images: number };
  background?: string;
  watermark: boolean;
  stream: false;
}

export function buildArkBody(req: ImageGenerationRequest): ArkGenerationBody {
  const responseFormat = readEnum(req.extraParams, 'response_format', ['url', 'b64_json'] as const, 'url') ?? 'url';

  const body: ArkGenerationBody = {
    model: req.modelKey,
    prompt: req.prompt,
    response_format: responseFormat,
    // 默认关水印:商品图带「AI 生成」水印会直接影响电商上架素材。
    // 上游默认值是 true,所以这里必须显式传 false 而不是省略。
    watermark: readBoolean(req.extraParams, 'watermark', false),
    stream: false,
  };

  const size = resolveArkSize(req);
  if (size) body.size = size;

  const outputFormat = readEnum(req.extraParams, 'output_format', ['png', 'jpeg'] as const, undefined);
  if (outputFormat) body.output_format = outputFormat;

  const background = readEnum(req.extraParams, 'background', ['transparent', 'opaque'] as const, undefined);
  if (background) body.background = background;

  const references = req.referenceImages ?? [];
  if (references.length === 1) {
    body.image = toArkDataUri(references[0] as { data: Buffer | Uint8Array; mimeType: string });
  } else if (references.length > 1) {
    body.image = references.map((ref) => toArkDataUri(ref));
  }

  // 出图张数:上游没有 n 参数,单张走 disabled,多张走组图模式。
  // 适配器只发一次调用;count 已由上层按 limits.maxOutputsPerCall 约束。
  if (req.count > 1) {
    const cap = Math.max(1, ARK_MAX_IMAGES_HARD_CAP - references.length);
    body.sequential_image_generation = 'auto';
    body.sequential_image_generation_options = {
      max_images: Math.min(req.count, cap),
    };
  } else {
    body.sequential_image_generation = 'disabled';
  }

  return body;
}

/**
 * Base64 参考图必须是 `data:image/<小写格式>;base64,<编码>`(文档明确要求格式名小写)。
 */
export function toArkDataUri(ref: { data: Buffer | Uint8Array; mimeType: string }): string {
  const mime = ref.mimeType.toLowerCase();
  return `data:${mime};base64,${toBase64(ref.data)}`;
}

/** 优先取分辨率档位(extraParams.size_tier),否则用 size 字符串 / 宽高 */
function resolveArkSize(req: ImageGenerationRequest): string | undefined {
  const tier = readEnum(req.extraParams, 'size_tier', ARK_SIZE_TIERS, undefined);
  if (tier) return tier;
  if (req.size) return req.size;
  if (req.width && req.height) return `${req.width}x${req.height}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

export interface ParsedArkResponse {
  images: GeneratedImage[];
  /** 组图场景下部分图失败的错误描述(已脱敏),用于记录 PARTIAL 状态 */
  perImageErrors: string[];
}

export function parseArkResponse(payload: unknown): ParsedArkResponse | { error: string; blocked?: boolean } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: '响应不是 JSON 对象' };
  }
  const root = payload as Record<string, unknown>;

  // 顶层 error:整个请求未产出任何图片
  const topError = root['error'];
  if (typeof topError === 'object' && topError !== null) {
    const e = topError as Record<string, unknown>;
    const code = typeof e['code'] === 'string' ? (e['code'] as string) : '';
    const message = typeof e['message'] === 'string' ? (e['message'] as string) : '';
    return {
      error: [code, message].filter(Boolean).join(' / ') || '上游返回了空的 error 对象',
      blocked: /moderation|审核|sensitive|risk/i.test(`${code} ${message}`),
    };
  }

  const data = root['data'];
  if (!Array.isArray(data)) {
    return { error: '响应缺少 data 数组' };
  }

  const images: GeneratedImage[] = [];
  const perImageErrors: string[] = [];

  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;

    const itemError = item['error'];
    if (typeof itemError === 'object' && itemError !== null) {
      const e = itemError as Record<string, unknown>;
      perImageErrors.push(
        sanitizeUpstreamMessage([e['code'], e['message']].filter((v) => typeof v === 'string').join(' / ')),
      );
      continue;
    }

    const url = typeof item['url'] === 'string' ? (item['url'] as string) : undefined;
    const base64 = typeof item['b64_json'] === 'string' ? (item['b64_json'] as string) : undefined;
    if (!url && !base64) continue;

    const outputFormat = typeof item['output_format'] === 'string' ? (item['output_format'] as string) : 'jpeg';
    const dims = parseSizeString(typeof item['size'] === 'string' ? (item['size'] as string) : undefined);

    images.push({
      ...(url ? { url } : {}),
      ...(base64 ? { base64 } : {}),
      mimeType: `image/${outputFormat === 'jpg' ? 'jpeg' : outputFormat}`,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    });
  }

  if (images.length === 0) {
    return {
      error:
        perImageErrors.length > 0
          ? `全部图片生成失败:${perImageErrors.join('; ')}`
          : 'data 数组中没有可用的 url 或 b64_json',
    };
  }
  return { images, perImageErrors };
}

/** 抽取 Ark 错误体。方舟错误体为顶层 { error: { code, message } } */
export function extractArkError(payload: unknown): { detail: string; structured: boolean } {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as Record<string, unknown>)['error'];
    if (typeof error === 'object' && error !== null) {
      const e = error as Record<string, unknown>;
      const parts = [e['code'], e['message']].filter((v): v is string => typeof v === 'string');
      if (parts.length > 0) return { detail: parts.join(' / '), structured: true };
    }
  }
  return { detail: sanitizeUpstreamMessage(payload), structured: false };
}

// ---------------------------------------------------------------------------
// 模型能力
// ---------------------------------------------------------------------------

export function describeArkImageModels(): ModelDescriptor[] {
  return [
    {
      // 唯一在官方文档 cURL 示例中出现、可 100% 核对的 Model ID
      modelKey: 'doubao-seedream-5-0-pro-260628',
      displayName: 'Doubao Seedream 5.0 pro',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: buildLimits({
        // 5.0 pro 不支持组图 => 单次且总计只出 1 张
        maxOutputs: 1,
        maxOutputsPerCall: 1,
        maxReferenceImages: 10,
        maxReferenceBytes: 30 * 1024 * 1024,
        // 走档位模式(extraParams.size_tier),不枚举固定像素尺寸
        sizes: [],
        sizeMode: 'width_height',
        minWidth: 512,
        maxWidth: 4096,
        minHeight: 512,
        maxHeight: 4096,
        // 文档只约束「总像素」与「宽高比」,未要求宽高为某数的整数倍 => 步长设 1
        dimensionStep: 1,
        deliveryMode: 'sync',
        resultCarrier: 'url',
        supportsNegativePrompt: false,
        supportsSeed: false,
        supportsImageEdit: true,
        maxPromptChars: 0,
        // 文档明确:url 在生成后 24 小时内有效
        resultUrlTtlSeconds: 86_400,
        docsUrl: DOCS_URL,
        verified: true,
      }),
    },
    {
      // 待真实联调:Seedream 4.0 的完整 Model ID(含日期后缀)未在文档正文给出,
      // 必须到方舟控制台「查询 Model ID」确认后替换本占位值,确认前不得对用户开放。
      modelKey: 'doubao-seedream-4-0',
      displayName: 'Doubao Seedream 4.0(Model ID 待控制台确认)',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: buildLimits({
        // 4.0 支持组图:max_images 上限 15,且「参考图 + 生成图 ≤ 15」
        maxOutputs: 15,
        maxOutputsPerCall: 15,
        maxReferenceImages: 14,
        maxReferenceBytes: 30 * 1024 * 1024,
        sizes: [],
        sizeMode: 'width_height',
        minWidth: 512,
        maxWidth: 4096,
        minHeight: 512,
        maxHeight: 4096,
        dimensionStep: 1,
        deliveryMode: 'sync',
        resultCarrier: 'url',
        supportsNegativePrompt: false,
        supportsSeed: false,
        supportsImageEdit: true,
        maxPromptChars: 0,
        resultUrlTtlSeconds: 86_400,
        docsUrl: DOCS_URL,
        // Model ID 未确认 => 未核对
        verified: false,
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export class ArkSeedreamImageProvider implements ImageProvider {
  readonly kind = 'ARK_SEEDREAM' as const;

  describeDefaultModels(): ModelDescriptor[] {
    return describeArkImageModels();
  }

  async submit(
    req: ImageGenerationRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<ImageGenerationOutcome> {
    const phase: CallPhase = 'submit';
    const baseUrl = trimTrailingSlash(creds.baseUrl || ARK_DEFAULT_BASE_URL);

    const outcome = await httpCall({
      url: `${baseUrl}/images/generations`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      json: buildArkBody(req),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return classifyTransportFailure(phase, PROVIDER_LABEL, outcome.transport);
    }

    const { response, durationMs } = outcome;
    if (response.status < 200 || response.status >= 300) {
      const { detail, structured } = extractArkError(response.json ?? response.bodyText);
      return classifyHttpFailure({
        phase,
        providerLabel: PROVIDER_LABEL,
        response,
        upstreamDetail: detail,
        hasStructuredError: structured,
      });
    }

    const parsed = parseArkResponse(response.json);
    if ('error' in parsed) {
      return parsed.blocked === true
        ? contentBlockedFailure(PROVIDER_LABEL, parsed.error, response.status)
        : malformedResponse(PROVIDER_LABEL, parsed.error, response.status);
    }
    return { kind: 'completed', images: parsed.images, upstreamDurationMs: durationMs };
  }

  async testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult> {
    // 方舟兼容 OpenAI 的 /models 列表接口,只读、不产生生成费用。
    // 待真实联调:若账号未开通 models 列表权限而返回 404,应改为在后台用一次
    // 1K 最小尺寸的真实出图做探测(会产生费用,需二次确认)。
    const baseUrl = trimTrailingSlash(creds.baseUrl || ARK_DEFAULT_BASE_URL);
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
      message: ok ? '连接正常' : sanitizeUpstreamMessage(extractArkError(outcome.response.json).detail),
      httpStatus: outcome.response.status,
      latencyMs: outcome.durationMs,
      ...(ok ? {} : { errorCode: ERROR_CODES.UPSTREAM_ERROR }),
    };
  }
}

/** readInt 供上层校验 extraParams.max_images 时复用 */
export function clampArkMaxImages(value: unknown): number | undefined {
  return readInt({ v: value }, 'v', 1, ARK_MAX_IMAGES_HARD_CAP, undefined);
}
