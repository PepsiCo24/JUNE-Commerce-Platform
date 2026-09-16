/**
 * 阿里云百炼(DashScope)通义万相 Wanx 文生图适配器。
 *
 * 核对来源(官方):
 *  - 阿里云帮助中心「万相-文生图V2版API参考」
 *    https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference
 * 核对日期:2026-09-16
 *
 * 形态:**异步(提交任务 + 轮询任务)**。这是本平台 5 家生图供应商里最典型的两段式协议。
 *  步骤 1:POST {baseUrl}/services/aigc/text2image/image-synthesis
 *          必须带请求头 `X-DashScope-Async: enable`(文档明确:缺少该头会报
 *          "current user api does not support synchronous calls"),
 *          响应只返回 { output: { task_id, task_status: 'PENDING' }, request_id }。
 *  步骤 2:GET {baseUrl}/tasks/{task_id},轮询直到 task_status 变为终态。
 *          文档建议轮询间隔 10 秒;查询接口默认 RPS 20。
 *
 * 国内 / 海外域名与鉴权(已核对):
 *  - 认证:`Authorization: Bearer <DASHSCOPE_API_KEY>`
 *  - 旧域名:https://dashscope.aliyuncs.com/api/v1(北京)、
 *            https://dashscope-intl.aliyuncs.com/api/v1(新加坡)
 *  - 文档建议迁移到业务空间专属域名:
 *            https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1
 *            https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1
 *    因此 baseUrl 必须由后台配置(含 WorkspaceId),适配器不猜测 WorkspaceId。
 *  - 文档明确:各地域 API Key 与请求地址不可混用,跨地域调用会鉴权失败。
 *
 * 文档明确的字段(已核对):
 *  - 请求体:{ model, input: { prompt, negative_prompt? },
 *              parameters: { size?, n?, prompt_extend?, watermark?, seed? } }
 *  - **negative_prompt 原生支持**(≤ 500 字符)—— 5 家里唯一支持反向提示词的
 *  - **seed 原生支持**,取值 [0, 2147483647]
 *  - n:取值 1~4,**默认值是 4**。默认值直接影响费用(费用 = 单价 × 张数),
 *       所以适配器永远显式传 n,绝不依赖默认值。
 *  - size:格式 `宽*高`(**分隔符是星号,不是小写 x**),这点与其他 4 家都不同。
 *          wan2.2 及以下:宽高均在 [512, 1440],最大 1440*1440;
 *          wan2.5-t2i-preview:总像素在 [1280*1280, 1440*1440],宽高比 [1:4, 4:1]。
 *  - prompt 长度:wan2.5-t2i-preview ≤ 2000 字符;wan2.2 / wan2.1 系列 ≤ 500;
 *                 wanx2.0-t2i-turbo ≤ 800(超出部分会被自动截断)
 *  - task_status 枚举:PENDING | RUNNING | SUCCEEDED | FAILED | CANCELED | UNKNOWN
 *  - 结果:output.results[] 中每项为 { url, orig_prompt, actual_prompt } 或 { code, message }
 *  - **图像 URL 有效期 24 小时**;task_id 查询有效期同样 24 小时
 *  - 部分成功:只要有一张成功,task_status 即为 SUCCEEDED,失败项在 results 里带 code/message;
 *              usage.image_count 只统计成功张数(计费口径)
 *  - 错误体:{ code, message, request_id }(创建任务失败时为顶层字段)
 *
 * 待真实联调:
 *  - **wan2.6 系列不适用本适配器**。文档明确 wan2.6 走新协议(messages 形态,
 *    支持 HTTP 同步调用),字段结构与本文件实现的旧版协议不同。
 *    如需接入 wan2.6,必须新增一个独立适配器,不能复用本文件。
 *  - **参考图 / 图生图**不在本端点范围内(image-synthesis 是纯文生图),
 *    因此 maxReferenceImages = 0。万相的图像编辑是另一组端点,未核对,待单独接入。
 *  - **限流响应头**:文档未说明 429 是否带标准 Retry-After,交由通用逻辑解析。
 *  - **UNKNOWN 状态**的确切触发条件(文档描述为「任务不存在或状态未知」)未细化,
 *    适配器将其映射为 UPSTREAM_RESULT_UNKNOWN 且不可重试,由人工核对。
 */

import { ERROR_CODES } from '@june/shared';

import {
  classifyHttpFailure,
  classifyTransportFailure,
  httpCall,
  malformedResponse,
  unknownResult,
  type CallPhase,
} from '../http';
import { buildLimits, readBoolean, readInt } from '../limits';
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
import { trimTrailingSlash } from './openai';

const PROVIDER_LABEL = '阿里云通义万相';
const DOCS_URL = 'https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference';
export const WANX_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';

/** 文档建议的轮询间隔:10 秒 */
export const WANX_POLL_INTERVAL_MS = 10_000;

export const WANX_TASK_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN'] as const;
export type WanxTaskStatus = (typeof WANX_TASK_STATUSES)[number];

// ---------------------------------------------------------------------------
// 请求体构造
// ---------------------------------------------------------------------------

export interface WanxSubmitBody {
  model: string;
  input: { prompt: string; negative_prompt?: string };
  parameters: {
    n: number;
    size?: string;
    prompt_extend?: boolean;
    watermark?: boolean;
    seed?: number;
  };
}

/**
 * 构造提交任务的 body。
 *
 * 注意两个容易踩的默认值:
 *  - n 默认是 4,不显式传就会按 4 张计费,所以这里永远传 req.count。
 *  - size 分隔符是 `*`,把平台内部的 "1024x1024" 转成 "1024*1024"。
 */
export function buildWanxSubmitBody(req: ImageGenerationRequest): WanxSubmitBody {
  const body: WanxSubmitBody = {
    model: req.modelKey,
    input: { prompt: req.prompt },
    parameters: {
      n: req.count,
    },
  };

  if (req.negativePrompt && req.negativePrompt.trim().length > 0) {
    body.input.negative_prompt = req.negativePrompt;
  }

  const size = toWanxSize(req);
  if (size) body.parameters.size = size;

  if (typeof req.seed === 'number' && Number.isInteger(req.seed) && req.seed >= 0 && req.seed <= 2_147_483_647) {
    body.parameters.seed = req.seed;
  }

  // prompt_extend 上游默认 true(智能改写)。改写可能引入受版权保护的内容而触发
  // IPInfringementSuspect / DataInspectionFailed,电商场景默认关掉更可控。
  body.parameters.prompt_extend = readBoolean(req.extraParams, 'prompt_extend', false);
  // watermark 上游默认 false,这里保持一致但允许后台开启
  body.parameters.watermark = readBoolean(req.extraParams, 'watermark', false);

  return body;
}

/** 平台内部统一用 "1024x1024";DashScope 要求 "1024*1024" */
export function toWanxSize(req: ImageGenerationRequest): string | undefined {
  if (req.size) {
    const match = /^(\d{2,5})[x*](\d{2,5})$/.exec(req.size.trim());
    if (match) return `${match[1]}*${match[2]}`;
  }
  if (req.width && req.height) return `${req.width}*${req.height}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

export interface WanxSubmitResult {
  taskId: string;
  taskStatus: WanxTaskStatus;
}

export function parseWanxSubmitResponse(payload: unknown): WanxSubmitResult | { error: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: '响应不是 JSON 对象' };
  }
  const root = payload as Record<string, unknown>;

  // 创建任务失败时错误码在顶层
  if (typeof root['code'] === 'string' && (root['code'] as string).length > 0) {
    return {
      error: [root['code'], root['message']].filter((v) => typeof v === 'string').join(' / '),
    };
  }

  const output = root['output'];
  if (typeof output !== 'object' || output === null) {
    return { error: '响应缺少 output 对象' };
  }
  const outputObj = output as Record<string, unknown>;
  const taskId = outputObj['task_id'];
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return { error: 'output 中缺少 task_id' };
  }
  const status = outputObj['task_status'];
  return {
    taskId,
    taskStatus: isWanxStatus(status) ? status : 'PENDING',
  };
}

export interface WanxPollResult {
  taskStatus: WanxTaskStatus;
  images: GeneratedImage[];
  /** 部分失败项的错误描述(已脱敏) */
  perImageErrors: string[];
  /** 任务级错误码 / 描述 */
  taskError?: string;
}

export function parseWanxPollResponse(payload: unknown): WanxPollResult | { error: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: '响应不是 JSON 对象' };
  }
  const root = payload as Record<string, unknown>;
  const output = root['output'];
  if (typeof output !== 'object' || output === null) {
    // 查询本身失败(如 InvalidApiKey)时错误码在顶层
    if (typeof root['code'] === 'string') {
      return { error: [root['code'], root['message']].filter((v) => typeof v === 'string').join(' / ') };
    }
    return { error: '响应缺少 output 对象' };
  }

  const outputObj = output as Record<string, unknown>;
  const status = outputObj['task_status'];
  if (!isWanxStatus(status)) {
    return { error: `未知的 task_status:${String(status)}` };
  }

  const images: GeneratedImage[] = [];
  const perImageErrors: string[] = [];
  const results = outputObj['results'];
  if (Array.isArray(results)) {
    for (const entry of results as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const url = item['url'];
      if (typeof url === 'string' && url.length > 0) {
        // 文档明确:输出图像格式为 PNG
        images.push({ url, mimeType: 'image/png' });
        continue;
      }
      if (typeof item['code'] === 'string') {
        perImageErrors.push(
          sanitizeUpstreamMessage([item['code'], item['message']].filter((v) => typeof v === 'string').join(' / ')),
        );
      }
    }
  }

  const taskErrorParts = [outputObj['code'], outputObj['message']].filter((v): v is string => typeof v === 'string');

  return {
    taskStatus: status,
    images,
    perImageErrors,
    ...(taskErrorParts.length > 0 ? { taskError: taskErrorParts.join(' / ') } : {}),
  };
}

function isWanxStatus(value: unknown): value is WanxTaskStatus {
  return typeof value === 'string' && (WANX_TASK_STATUSES as readonly string[]).includes(value);
}

/** 抽取 DashScope 错误体:{ code, message, request_id } 为顶层字段 */
export function extractWanxError(payload: unknown): { detail: string; structured: boolean } {
  if (typeof payload === 'object' && payload !== null) {
    const root = payload as Record<string, unknown>;
    const parts = [root['code'], root['message']].filter((v): v is string => typeof v === 'string');
    if (parts.length > 0) return { detail: parts.join(' / '), structured: true };
  }
  return { detail: sanitizeUpstreamMessage(payload), structured: false };
}

// ---------------------------------------------------------------------------
// 模型能力
// ---------------------------------------------------------------------------

function wanxLimits(args: { maxPromptChars: number; sizes: string[] }): ReturnType<typeof buildLimits> {
  return buildLimits({
    // 文档明确:n 取值 1~4
    maxOutputs: 4,
    maxOutputsPerCall: 4,
    // image-synthesis 是纯文生图端点,不接受参考图
    maxReferenceImages: 0,
    sizes: args.sizes,
    sizeMode: 'size_string',
    deliveryMode: 'async_poll',
    resultCarrier: 'url',
    // 5 家里唯一原生支持 negative_prompt 的
    supportsNegativePrompt: true,
    supportsSeed: true,
    supportsImageEdit: false,
    maxPromptChars: args.maxPromptChars,
    // 文档明确:图像 URL 有效期 24 小时
    resultUrlTtlSeconds: 86_400,
    docsUrl: DOCS_URL,
    verified: true,
  });
}

export function describeWanxImageModels(): ModelDescriptor[] {
  return [
    {
      modelKey: 'wan2.5-t2i-preview',
      displayName: '通义万相 2.5 preview 文生图',
      capabilities: ['TEXT_TO_IMAGE'],
      // 文档给的是「常见比例推荐分辨率」,总像素须在 [1280*1280, 1440*1440]
      limits: wanxLimits({
        maxPromptChars: 2_000,
        sizes: ['1280x1280', '1104x1472', '1472x1104', '960x1696', '1696x960'],
      }),
    },
    {
      modelKey: 'wan2.2-t2i-flash',
      displayName: '通义万相 2.2 极速版 文生图',
      capabilities: ['TEXT_TO_IMAGE'],
      // 文档明确:wan2.2 及以下宽高均在 [512, 1440],最大 1440x1440
      limits: wanxLimits({
        maxPromptChars: 500,
        sizes: ['1024x1024', '1440x810', '810x1440', '1280x720', '720x1280'],
      }),
    },
    {
      modelKey: 'wan2.2-t2i-plus',
      displayName: '通义万相 2.2 专业版 文生图',
      capabilities: ['TEXT_TO_IMAGE'],
      limits: wanxLimits({
        maxPromptChars: 500,
        sizes: ['1024x1024', '1440x810', '810x1440', '1280x720', '720x1280'],
      }),
    },
    {
      modelKey: 'wanx2.1-t2i-turbo',
      displayName: '通义万相 2.1 极速版 文生图',
      capabilities: ['TEXT_TO_IMAGE'],
      limits: wanxLimits({ maxPromptChars: 500, sizes: ['1024x1024', '1280x720', '720x1280'] }),
    },
  ];
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export class AliyunWanxImageProvider implements ImageProvider {
  readonly kind = 'ALIYUN_WANX' as const;

  describeDefaultModels(): ModelDescriptor[] {
    return describeWanxImageModels();
  }

  async submit(
    req: ImageGenerationRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<ImageGenerationOutcome> {
    const phase: CallPhase = 'submit';
    const baseUrl = trimTrailingSlash(creds.baseUrl || WANX_DEFAULT_BASE_URL);

    const outcome = await httpCall({
      url: `${baseUrl}/services/aigc/text2image/image-synthesis`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        'content-type': 'application/json',
        // 文档明确:缺少该头会报 "current user api does not support synchronous calls"
        'x-dashscope-async': 'enable',
        accept: 'application/json',
      },
      json: buildWanxSubmitBody(req),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return classifyTransportFailure(phase, PROVIDER_LABEL, outcome.transport);
    }

    const { response } = outcome;
    if (response.status < 200 || response.status >= 300) {
      const { detail, structured } = extractWanxError(response.json ?? response.bodyText);
      return classifyHttpFailure({
        phase,
        providerLabel: PROVIDER_LABEL,
        response,
        upstreamDetail: detail,
        hasStructuredError: structured,
      });
    }

    const parsed = parseWanxSubmitResponse(response.json);
    if ('error' in parsed) {
      return malformedResponse(PROVIDER_LABEL, parsed.error, response.status);
    }

    // 异步供应商:提交成功只拿到 task_id,交给上层调度轮询。
    // 文档特别提示「请勿重复创建任务,轮询获取即可」。
    return { kind: 'pending', providerTaskId: parsed.taskId, pollAfterMs: WANX_POLL_INTERVAL_MS };
  }

  async poll(
    providerTaskId: string,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<PollOutcome> {
    const phase: CallPhase = 'poll';
    const baseUrl = trimTrailingSlash(creds.baseUrl || WANX_DEFAULT_BASE_URL);
    const startedAt = Date.now();

    const outcome = await httpCall({
      url: `${baseUrl}/tasks/${encodeURIComponent(providerTaskId)}`,
      method: 'GET',
      headers: { authorization: `Bearer ${creds.apiKey}`, accept: 'application/json' },
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return classifyTransportFailure(phase, PROVIDER_LABEL, outcome.transport, providerTaskId);
    }

    const { response } = outcome;
    if (response.status < 200 || response.status >= 300) {
      const { detail, structured } = extractWanxError(response.json ?? response.bodyText);
      return classifyHttpFailure({
        phase,
        providerLabel: PROVIDER_LABEL,
        response,
        upstreamDetail: detail,
        providerTaskId,
        hasStructuredError: structured,
      });
    }

    const parsed = parseWanxPollResponse(response.json);
    if ('error' in parsed) {
      return malformedResponse(PROVIDER_LABEL, parsed.error, response.status);
    }

    return mapWanxPollResult(parsed, providerTaskId, Date.now() - startedAt);
  }

  async testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult> {
    // 用一个必然不存在的 task_id 查询任务接口做鉴权探测:只读、不产生生成费用。
    // 鉴权失败会返回 InvalidApiKey;鉴权成功则返回「任务不存在」类错误或 UNKNOWN 状态。
    const baseUrl = trimTrailingSlash(creds.baseUrl || WANX_DEFAULT_BASE_URL);
    const probeTaskId = '00000000-0000-0000-0000-000000000000';
    const outcome = await httpCall({
      url: `${baseUrl}/tasks/${probeTaskId}`,
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

    const { detail } = extractWanxError(outcome.response.json);
    // 401 / InvalidApiKey 视为鉴权失败;其余(含 404 任务不存在)视为通路正常
    const authFailed = outcome.response.status === 401 || /InvalidApiKey|Unauthorized/i.test(detail);
    return {
      ok: !authFailed,
      message: authFailed ? sanitizeUpstreamMessage(detail) : '连接与鉴权正常(探测任务号不存在属预期)',
      httpStatus: outcome.response.status,
      latencyMs: outcome.durationMs,
      ...(authFailed ? { errorCode: ERROR_CODES.UPSTREAM_ERROR } : {}),
    };
  }
}

/**
 * task_status → 统一三态。
 *
 * 映射依据:
 *  - PENDING / RUNNING → pending,继续轮询
 *  - SUCCEEDED → completed(可能是部分成功:results 里既有 url 又有 code)
 *  - FAILED → failed,可重试(任务已终结,重试不会产生重复计费)
 *  - CANCELED → failed,不可重试
 *  - UNKNOWN → 「任务不存在或状态未知」→ UPSTREAM_RESULT_UNKNOWN,不可重试,需人工核对
 */
export function mapWanxPollResult(
  parsed: WanxPollResult,
  providerTaskId: string,
  upstreamDurationMs: number,
): PollOutcome {
  switch (parsed.taskStatus) {
    case 'PENDING':
    case 'RUNNING':
      return { kind: 'pending', providerTaskId, pollAfterMs: WANX_POLL_INTERVAL_MS };

    case 'SUCCEEDED': {
      if (parsed.images.length === 0) {
        return malformedResponse(
          PROVIDER_LABEL,
          `task_status 为 SUCCEEDED 但 results 中没有可用 url;失败项:${parsed.perImageErrors.join('; ')}`,
        );
      }
      return { kind: 'completed', images: parsed.images, upstreamDurationMs, providerTaskId };
    }

    case 'FAILED':
      return {
        kind: 'failed',
        errorCode: ERROR_CODES.UPSTREAM_ERROR,
        message: sanitizeUpstreamMessage(
          `[${PROVIDER_LABEL}] 任务失败:${parsed.taskError ?? (parsed.perImageErrors.join('; ') || '上游未提供原因')}`,
        ),
        retryable: true,
        providerTaskId,
      };

    case 'CANCELED':
      return {
        kind: 'failed',
        errorCode: ERROR_CODES.UPSTREAM_ERROR,
        message: `[${PROVIDER_LABEL}] 任务已被取消`,
        retryable: false,
        providerTaskId,
      };

    case 'UNKNOWN':
      return unknownResult(
        PROVIDER_LABEL,
        '上游返回 task_status = UNKNOWN(任务不存在或状态未知),可能已执行并计费,需人工核对后再决定',
        providerTaskId,
      );
  }
}

/** 供上层校验 extraParams 中的张数配置 */
export function clampWanxCount(value: unknown): number | undefined {
  return readInt({ v: value }, 'v', 1, 4, undefined);
}
