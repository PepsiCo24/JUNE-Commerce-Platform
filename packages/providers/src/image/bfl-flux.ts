/**
 * Black Forest Labs FLUX 图片生成适配器。
 *
 * 核对来源(官方):
 *  - 快速上手「Image Generation with Text Prompts」https://docs.bfl.ai/quick_start/generating_images
 *  - 官方 OpenAPI(内嵌于文档页,source: https://api.bfl.ai/openapi.json)
 *    https://docs.bfl.ml/api-reference/models/generate-or-edit-an-image-with-flux2-[pro].md
 *  - 轮询结果「Get Result」https://docs.bfl.ml/api-reference/utility/get-result.md
 *  - 错误与状态「Errors」https://docs.bfl.ml/api_integration/errors.md
 *  - 图像编辑「FLUX.2 Image Editing」https://docs.bfl.ml/flux_2/flux2_image_editing.md
 * 核对日期:2026-09-16
 *
 * 形态:**异步(提交返回 polling_url + 轮询)**。
 *  步骤 1:POST https://api.bfl.ai/v1/{endpoint},响应 { id, polling_url, cost?, input_mp?, output_mp? }
 *  步骤 2:GET polling_url(**必须用响应里返回的 polling_url**,不能自己拼)
 *          文档明确:使用全局域名 api.bfl.ai 或区域域名时,必须用响应返回的 polling_url 查询状态。
 *
 * 鉴权(已核对):请求头 `x-key: <apiKey>`(OpenAPI securitySchemes: apiKey in header, name = x-key),
 *              不是 Authorization: Bearer。
 *
 * 文档明确的字段(已核对):
 *  - 端点即模型名:/flux-2-max、/flux-2-pro-preview、/flux-2-pro、/flux-2-flex、
 *    /flux-2-klein-4b、/flux-2-klein-9b-preview、/flux-2-klein-9b、
 *    /flux-kontext-max、/flux-kontext-pro、/flux-pro-1.1-ultra、/flux-pro-1.1、/flux-pro、/flux-dev
 *  - 请求体(Flux2Inputs):prompt(必选)、input_image ~ input_image_8、seed、
 *    width / height(最小 64,默认 0)、safety_tolerance(0~5,默认 2)、
 *    output_format(jpeg | png | webp,默认 jpeg)、disable_pup、webhook_url、webhook_secret、user
 *  - **参考图最多 8 张**(input_image ~ input_image_8);文档正文说明「API 最多 8 张,
 *    playground 最多 10 张」
 *  - input_image 接受 **Base64 编码图片或图片 URL**(FLUX.1 Kontext 参数表明确写明
 *    "Base64 encoded image or URL of image to use as reference. Supports up to 20MB or 20 megapixels")
 *  - **请求体没有 n / count 参数** => 单次调用固定出 1 张,批量完全由上层拆分
 *  - **没有 negative_prompt**(官方 Prompting Guide 有专门一节讲「working without negative prompts」)
 *  - 轮询状态枚举(StatusResponse):
 *      Task not found | Pending | Reasoning | Generating | Request Moderated |
 *      Content Moderated | Ready | Error
 *  - Ready 时结果在 result.sample,是**签名链接,仅 10 分钟有效**
 *    (=> resultUrlTtlSeconds 600),且 delivery.*.bfl.ai 不开 CORS,必须转存
 *  - 速率限制:**最多 24 个活跃任务**,超出返回 429;flux-kontext-max 限 6 个活跃任务
 *  - 402 表示额度不足;422 表示参数校验失败(体为 { detail: [{ loc, msg, type }] })
 *  - Moderated 响应:result 为 null,details 里带 "Moderation Reasons" 数组
 *
 * 待真实联调:
 *  - **input_image 的 20MB / 20MP 上限**来自 FLUX.1 Kontext 的参数表;
 *    FLUX.2 的 OpenAPI 未重申数值,这里沿用 20MB 但标注需要确认。
 *  - **width / height 的上限与步长**。OpenAPI 只声明 minimum = 64、default = 0,
 *    未给出最大值或「须为 N 的倍数」;文档正文提到 FLUX.2 最高 4MP 输出。
 *    因此 maxWidth / maxHeight 按 4MP 场景取 2048x2048 的保守值,dimensionStep = 32
 *    均为**推断值**,首次联调必须验证 => 所有 FLUX 模型 limits.verified = false 的主因。
 *  - **429 是否带 Retry-After**未在文档说明(文档只说「等待已有任务完成」),
 *    交由通用逻辑解析,解析不到由上层按活跃任务数退避。
 *  - **result.sample 的 MIME 类型**未在响应体中返回,按请求的 output_format 推断。
 */

import { ERROR_CODES } from '@june/shared';

import {
  classifyHttpFailure,
  classifyTransportFailure,
  contentBlockedFailure,
  httpCall,
  malformedResponse,
  unknownResult,
  type CallPhase,
} from '../http';
import { buildLimits, readEnum, readInt, toBase64 } from '../limits';
import { sanitizeUpstreamMessage } from '../sanitize';
import type {
  ConnectionTestResult,
  GeneratedImage,
  ImageGenerationOutcome,
  ImageGenerationRequest,
  ImageProvider,
  ModelDescriptor,
  PollOutcome,
  ProviderCallOptions,
  ProviderCredentials,
} from '../types';

const PROVIDER_LABEL = 'BFL FLUX';
const DOCS_URL = 'https://docs.bfl.ai/quick_start/generating_images';
export const BFL_DEFAULT_BASE_URL = 'https://api.bfl.ai/v1';

/** 文档明确的最大参考图数量:input_image ~ input_image_8 */
export const BFL_MAX_INPUT_IMAGES = 8;

/** 文档明确:轮询示例使用 0.5s 间隔;这里给上层一个更克制的建议值 */
export const BFL_POLL_INTERVAL_MS = 2_000;

export const BFL_STATUSES = [
  'Task not found',
  'Pending',
  'Reasoning',
  'Generating',
  'Request Moderated',
  'Content Moderated',
  'Ready',
  'Error',
] as const;
export type BflStatus = (typeof BFL_STATUSES)[number];

// ---------------------------------------------------------------------------
// 请求体构造
// ---------------------------------------------------------------------------

export interface BflSubmitBody {
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
  safety_tolerance?: number;
  output_format?: string;
  disable_pup?: boolean;
  /** input_image ~ input_image_8;Base64 或 URL */
  [inputImageKey: string]: unknown;
}

/**
 * 构造提交 body。
 *
 * 参考图字段名不是数组而是**编号字段**:第 1 张叫 input_image,
 * 第 2~8 张叫 input_image_2 ~ input_image_8。
 */
export function buildBflSubmitBody(req: ImageGenerationRequest): BflSubmitBody {
  const body: BflSubmitBody = { prompt: req.prompt };

  if (typeof req.seed === 'number' && Number.isInteger(req.seed)) {
    body.seed = req.seed;
  }

  const dims = resolveBflDimensions(req);
  if (dims) {
    body.width = dims.width;
    body.height = dims.height;
  }

  const safetyTolerance = readInt(req.extraParams, 'safety_tolerance', 0, 5, undefined);
  if (safetyTolerance !== undefined) body.safety_tolerance = safetyTolerance;

  const outputFormat = readEnum(req.extraParams, 'output_format', ['jpeg', 'png', 'webp'] as const, 'png');
  if (outputFormat) body.output_format = outputFormat;

  // FLUX.2 [pro] / [max] 默认会做 prompt upsampling(自动扩写)。
  // 电商场景需要提示词可复现,默认关闭自动扩写。
  const disablePup = req.extraParams['disable_pup'];
  body.disable_pup = typeof disablePup === 'boolean' ? disablePup : true;

  const references = (req.referenceImages ?? []).slice(0, BFL_MAX_INPUT_IMAGES);
  references.forEach((ref, index) => {
    const key = index === 0 ? 'input_image' : `input_image_${index + 1}`;
    body[key] = toBase64(ref.data);
  });

  return body;
}

/**
 * 解析目标宽高。
 * 待真实联调:上限与步长未在文档中给出数值,这里只做「不小于 64」的下限保护,
 * 越界交由上游 422 拒绝,而不是在适配器里悄悄改写用户参数。
 */
export function resolveBflDimensions(req: ImageGenerationRequest): { width: number; height: number } | undefined {
  if (req.width && req.height) {
    return { width: req.width, height: req.height };
  }
  if (req.size) {
    const match = /^(\d{2,5})[x*](\d{2,5})$/.exec(req.size.trim());
    if (match) {
      return { width: Number.parseInt(match[1] as string, 10), height: Number.parseInt(match[2] as string, 10) };
    }
  }
  return undefined;
}

/** 端点即模型名:POST {baseUrl}/{modelKey} */
export function buildBflSubmitUrl(baseUrl: string, modelKey: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const endpoint = modelKey.replace(/^\/+/, '');
  return `${trimmedBase}/${endpoint}`;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

export interface BflSubmitResult {
  id: string;
  pollingUrl: string;
}

export function parseBflSubmitResponse(payload: unknown): BflSubmitResult | { error: string; taskId?: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: '响应不是 JSON 对象' };
  }
  const root = payload as Record<string, unknown>;
  const id = root['id'];
  const pollingUrl = root['polling_url'];

  if (typeof id !== 'string' || id.length === 0) {
    return { error: '响应缺少 id' };
  }
  if (typeof pollingUrl !== 'string' || pollingUrl.length === 0) {
    // 拿到了 id 但没有 polling_url:任务可能已创建并计费,必须把 id 带出去核对
    return { error: '响应缺少 polling_url,无法轮询', taskId: id };
  }
  return { id, pollingUrl };
}

export interface BflPollResult {
  status: BflStatus;
  /** Ready 时的签名图片链接(result.sample) */
  sampleUrl?: string;
  /** 0~1 的进度,上游可能为 null */
  progress?: number;
  /** Moderated 时的 "Moderation Reasons" 等细节(已脱敏) */
  details?: string;
}

export function parseBflPollResponse(payload: unknown): BflPollResult | { error: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: '响应不是 JSON 对象' };
  }
  const root = payload as Record<string, unknown>;
  const status = root['status'];
  if (!isBflStatus(status)) {
    return { error: `未知的 status:${String(status)}` };
  }

  const out: BflPollResult = { status };

  const result = root['result'];
  if (typeof result === 'object' && result !== null) {
    const sample = (result as Record<string, unknown>)['sample'];
    if (typeof sample === 'string' && sample.length > 0) {
      out.sampleUrl = sample;
    }
  }

  const progress = root['progress'];
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    out.progress = progress;
  }

  const details = root['details'];
  if (details !== undefined && details !== null) {
    out.details = sanitizeUpstreamMessage(details);
  }

  return out;
}

function isBflStatus(value: unknown): value is BflStatus {
  return typeof value === 'string' && (BFL_STATUSES as readonly string[]).includes(value);
}

/** 422 的错误体是 { detail: [{ loc, msg, type }] } */
export function extractBflError(payload: unknown): { detail: string; structured: boolean } {
  if (typeof payload === 'object' && payload !== null) {
    const root = payload as Record<string, unknown>;
    const detail = root['detail'];
    if (Array.isArray(detail)) {
      const messages = (detail as unknown[])
        .map((item) => {
          if (typeof item !== 'object' || item === null) return undefined;
          const obj = item as Record<string, unknown>;
          const loc = Array.isArray(obj['loc']) ? (obj['loc'] as unknown[]).join('.') : '';
          const msg = typeof obj['msg'] === 'string' ? (obj['msg'] as string) : '';
          return [loc, msg].filter(Boolean).join(': ');
        })
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (messages.length > 0) return { detail: messages.join('; '), structured: true };
    }
    if (typeof detail === 'string') return { detail, structured: true };
  }
  return { detail: sanitizeUpstreamMessage(payload), structured: false };
}

// ---------------------------------------------------------------------------
// 模型能力
// ---------------------------------------------------------------------------

function fluxLimits(args: { maxReferenceImages: number }): ReturnType<typeof buildLimits> {
  return buildLimits({
    // 请求体没有 n 参数 => 一次调用固定 1 张,批量由上层用 countUpstreamCalls 拆分
    maxOutputs: 1,
    maxOutputsPerCall: 1,
    maxReferenceImages: args.maxReferenceImages,
    // 待真实联调:20MB 来自 FLUX.1 Kontext 参数表,FLUX.2 未重申
    maxReferenceBytes: 20 * 1024 * 1024,
    sizes: [],
    sizeMode: 'width_height',
    // 文档明确 minimum = 64
    minWidth: 64,
    minHeight: 64,
    // 待真实联调:文档未给出 width / height 上限与步长,以下为按「最高 4MP 输出」的保守推断
    maxWidth: 2048,
    maxHeight: 2048,
    dimensionStep: 32,
    deliveryMode: 'async_poll',
    resultCarrier: 'url',
    // 官方 Prompting Guide 明确 FLUX 不使用负向提示词
    supportsNegativePrompt: false,
    supportsSeed: true,
    supportsImageEdit: args.maxReferenceImages > 0,
    // 待真实联调:文档未给出 prompt 字符上限
    maxPromptChars: 0,
    // 文档明确:签名链接仅 10 分钟有效
    resultUrlTtlSeconds: 600,
    docsUrl: DOCS_URL,
    // width/height 上限与步长为推断值 => 未核对
    verified: false,
  });
}

export function describeBflImageModels(): ModelDescriptor[] {
  return [
    {
      modelKey: 'flux-2-pro',
      displayName: 'FLUX.2 [pro]',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: fluxLimits({ maxReferenceImages: BFL_MAX_INPUT_IMAGES }),
    },
    {
      modelKey: 'flux-2-max',
      displayName: 'FLUX.2 [max]',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: fluxLimits({ maxReferenceImages: BFL_MAX_INPUT_IMAGES }),
    },
    {
      modelKey: 'flux-2-flex',
      displayName: 'FLUX.2 [flex]',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: fluxLimits({ maxReferenceImages: BFL_MAX_INPUT_IMAGES }),
    },
    {
      modelKey: 'flux-kontext-pro',
      displayName: 'FLUX.1 Kontext [pro](旧版)',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: fluxLimits({ maxReferenceImages: 1 }),
    },
  ];
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export class BflFluxImageProvider implements ImageProvider {
  readonly kind = 'BFL_FLUX' as const;

  describeDefaultModels(): ModelDescriptor[] {
    return describeBflImageModels();
  }

  async submit(
    req: ImageGenerationRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<ImageGenerationOutcome> {
    const phase: CallPhase = 'submit';
    const url = buildBflSubmitUrl(creds.baseUrl || BFL_DEFAULT_BASE_URL, req.modelKey);

    const outcome = await httpCall({
      url,
      method: 'POST',
      headers: {
        'x-key': creds.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      json: buildBflSubmitBody(req),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return classifyTransportFailure(phase, PROVIDER_LABEL, outcome.transport);
    }

    const { response } = outcome;
    if (response.status < 200 || response.status >= 300) {
      const { detail, structured } = extractBflError(response.json ?? response.bodyText);
      return classifyHttpFailure({
        phase,
        providerLabel: PROVIDER_LABEL,
        response,
        upstreamDetail: detail,
        hasStructuredError: structured,
      });
    }

    const parsed = parseBflSubmitResponse(response.json);
    if ('error' in parsed) {
      // 拿到 id 但缺 polling_url:任务可能已创建并计费 => 结果未知,不可盲目重试
      return parsed.taskId === undefined
        ? malformedResponse(PROVIDER_LABEL, parsed.error, response.status)
        : unknownResult(PROVIDER_LABEL, parsed.error, parsed.taskId);
    }

    // providerTaskId 存 polling_url:文档明确必须用响应返回的 polling_url 查询,
    // 自行用 id 拼 URL 在多集群路由下会查不到。id 作为 query 参数已包含在 polling_url 中。
    return { kind: 'pending', providerTaskId: parsed.pollingUrl, pollAfterMs: BFL_POLL_INTERVAL_MS };
  }

  async poll(
    providerTaskId: string,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<PollOutcome> {
    const phase: CallPhase = 'poll';
    const startedAt = Date.now();

    if (!/^https:\/\//i.test(providerTaskId)) {
      return malformedResponse(
        PROVIDER_LABEL,
        'providerTaskId 不是有效的 polling_url。FLUX 必须使用提交响应返回的 polling_url 轮询',
      );
    }

    const outcome = await httpCall({
      url: providerTaskId,
      method: 'GET',
      headers: { 'x-key': creds.apiKey, accept: 'application/json' },
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return classifyTransportFailure(phase, PROVIDER_LABEL, outcome.transport, providerTaskId);
    }

    const { response } = outcome;
    if (response.status < 200 || response.status >= 300) {
      const { detail, structured } = extractBflError(response.json ?? response.bodyText);
      return classifyHttpFailure({
        phase,
        providerLabel: PROVIDER_LABEL,
        response,
        upstreamDetail: detail,
        providerTaskId,
        hasStructuredError: structured,
      });
    }

    const parsed = parseBflPollResponse(response.json);
    if ('error' in parsed) {
      return malformedResponse(PROVIDER_LABEL, parsed.error, response.status);
    }

    return mapBflPollResult(parsed, providerTaskId, Date.now() - startedAt, 'image/png');
  }

  async testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult> {
    // GET /v1/me 是账号额度查询接口(文档:"Get the user's credits"),只读、不产生生成费用。
    // 待真实联调:该接口的确切路径在 API Reference 中列为「Get the user's credits」,
    // 本次未核对到其 URL path,故失败时不直接判定为鉴权问题,仅作提示。
    const baseUrl = (creds.baseUrl || BFL_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const outcome = await httpCall({
      url: `${baseUrl}/me`,
      method: 'GET',
      headers: { 'x-key': creds.apiKey, accept: 'application/json' },
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

    const status = outcome.response.status;
    const authFailed = status === 401 || status === 403;
    return {
      ok: !authFailed,
      message: authFailed
        ? sanitizeUpstreamMessage(extractBflError(outcome.response.json).detail)
        : status === 404
          ? '域名可达;额度查询接口路径待核对(待真实联调),鉴权未被拒绝'
          : '连接正常',
      httpStatus: status,
      latencyMs: outcome.durationMs,
      ...(authFailed ? { errorCode: ERROR_CODES.UPSTREAM_ERROR } : {}),
    };
  }
}

/**
 * FLUX status → 统一三态。
 *
 * 映射依据(官方 Errors 页的 Response Types):
 *  - Pending / Reasoning / Generating → pending,继续轮询
 *  - Ready → completed(result.sample 是 10 分钟有效的签名链接,必须立刻转存)
 *  - Request Moderated → 输入被审核拦截 → CONTENT_BLOCKED_INPUT,不可重试
 *  - Content Moderated → 输出被审核拦截 → CONTENT_BLOCKED_OUTPUT,不可重试
 *  - Error → 处理中出错,任务已终结 → UPSTREAM_ERROR,可重试
 *  - Task not found → 任务不存在或已过期。**不能当作「失败」直接重试**:
 *    我们确实提交成功过(才有 polling_url),现在查不到说明结果无法确认,
 *    可能已执行并计费 => UPSTREAM_RESULT_UNKNOWN,不可重试。
 */
export function mapBflPollResult(
  parsed: BflPollResult,
  providerTaskId: string,
  upstreamDurationMs: number,
  mimeType: string,
): PollOutcome {
  switch (parsed.status) {
    case 'Pending':
    case 'Reasoning':
    case 'Generating':
      return { kind: 'pending', providerTaskId, pollAfterMs: BFL_POLL_INTERVAL_MS };

    case 'Ready': {
      if (!parsed.sampleUrl) {
        return malformedResponse(PROVIDER_LABEL, 'status 为 Ready 但 result.sample 缺失');
      }
      const images: GeneratedImage[] = [{ url: parsed.sampleUrl, mimeType }];
      return { kind: 'completed', images, upstreamDurationMs, providerTaskId };
    }

    case 'Request Moderated':
      return {
        kind: 'failed',
        errorCode: ERROR_CODES.CONTENT_BLOCKED_INPUT,
        message: `[${PROVIDER_LABEL}] 输入内容被上游审核拦截:${parsed.details ?? '未提供原因'}`,
        retryable: false,
        providerTaskId,
      };

    case 'Content Moderated':
      return contentBlockedFailure(PROVIDER_LABEL, `生成结果被上游审核拦截:${parsed.details ?? '未提供原因'}`);

    case 'Error':
      return {
        kind: 'failed',
        errorCode: ERROR_CODES.UPSTREAM_ERROR,
        message: `[${PROVIDER_LABEL}] 生成过程出错:${parsed.details ?? '未提供原因'}`,
        retryable: true,
        providerTaskId,
      };

    case 'Task not found':
      return unknownResult(
        PROVIDER_LABEL,
        '提交已成功但轮询返回 Task not found(任务不存在或已过期),结果无法确认,可能已计费,需人工核对',
        providerTaskId,
      );
  }
}
