/**
 * 统一 HTTP 层:undici request + 超时 + AbortSignal + 失败分类。
 *
 * 关键约束(真实实现,不是注释):
 *  1. 所有上游调用都带超时。默认 120s,可按模型配置覆盖。
 *  2. 同时尊重上层的取消信号(用户取消任务 / Worker 优雅退出)。
 *  3. 严格区分「确定失败」与「结果未知」。判定依据见 classifyTransportFailure /
 *     classifyHttpFailure 的注释,核心是:提交阶段一旦无法确认上游是否已执行,
 *     就必须返回 UPSTREAM_RESULT_UNKNOWN 而不是让上层重试 —— 重试等于二次计费。
 */

import { request } from 'undici';

import { ERROR_CODES, type ErrorCode } from '@june/shared';

import { formatUpstreamMessage } from './sanitize';
import type { ProviderFailure } from './types';

/** 默认上游超时。生图普遍在 10~90s,留足余量但不无限等待 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 调用阶段。
 * - submit:发起生成。失败若无法确认上游是否执行 → 结果未知。
 * - poll:查询已提交任务的结果。查询本身是幂等只读的,超时可以安全重试。
 */
export type CallPhase = 'submit' | 'poll';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface HttpRequestSpec {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  /** JSON 请求体;与 formData 互斥 */
  json?: unknown;
  /** multipart/form-data 请求体(OpenAI images/edits 需要);与 json 互斥 */
  formData?: FormData;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  /** bodyText 的 JSON.parse 结果,解析失败为 undefined */
  json: unknown;
}

export type TransportErrorCause = 'timeout' | 'aborted' | 'network';

export interface TransportError {
  cause: TransportErrorCause;
  detail: string;
}

export type HttpOutcome =
  | { ok: true; response: HttpResponse; durationMs: number }
  | { ok: false; transport: TransportError; durationMs: number };

/**
 * 执行一次 HTTP 调用。不抛异常 —— 传输层错误以 { ok: false } 返回,
 * 由调用方结合 CallPhase 决定语义(可重试 / 结果未知)。
 */
export async function httpCall(spec: HttpRequestSpec): Promise<HttpOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = spec.signal ? AbortSignal.any([timeoutSignal, spec.signal]) : timeoutSignal;

  try {
    const body = spec.formData ?? (spec.json === undefined ? undefined : JSON.stringify(spec.json));
    const res = await request(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: body as never,
      signal,
      // 除整体 AbortSignal 外再加一层 undici 自身的超时,避免响应体挂住不返回
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const bodyText = await res.body.text();
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      response: {
        status: res.statusCode,
        headers: normalizeHeaders(res.headers),
        bodyText,
        json: safeJsonParse(bodyText),
      },
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      transport: {
        cause: resolveTransportCause(err, timeoutSignal, spec.signal),
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      },
    };
  }
}

function resolveTransportCause(
  err: unknown,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): TransportErrorCause {
  if (timeoutSignal.aborted) return 'timeout';
  if (callerSignal?.aborted) return 'aborted';
  const name = err instanceof Error ? err.name : '';
  const code = (err as { code?: string } | null)?.code ?? '';
  if (name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return 'timeout';
  }
  if (name === 'AbortError' || code === 'UND_ERR_ABORTED') return 'aborted';
  return 'network';
}

function normalizeHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function safeJsonParse(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 失败分类
// ---------------------------------------------------------------------------

/**
 * 解析 Retry-After。RFC 9110 允许两种形式:
 *  - delta-seconds:"120"
 *  - HTTP-date:"Wed, 21 Oct 2026 07:28:00 GMT"
 * 解析不出来返回 undefined,由上层用默认退避。
 */
export function parseRetryAfterSeconds(headerValue: string | undefined, now: number = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? seconds : undefined;
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  const seconds = Math.ceil((asDate - now) / 1000);
  return seconds > 0 ? seconds : 0;
}

/**
 * 传输层错误 → 统一失败语义。
 *
 * submit 阶段的超时 / 连接中断是典型的「结果未知」:请求可能已经到达上游并开始计费,
 * 只是响应没回来。此时必须返回 UPSTREAM_RESULT_UNKNOWN 且 retryable = false。
 * poll 阶段是只读查询,超时重试没有副作用,返回 UPSTREAM_TIMEOUT 且 retryable = true。
 */
export function classifyTransportFailure(
  phase: CallPhase,
  providerLabel: string,
  transport: TransportError,
  providerTaskId?: string,
): ProviderFailure {
  if (transport.cause === 'aborted') {
    // 上层主动取消。对提交阶段同样是结果未知:取消发生在响应之前,上游可能已执行。
    return phase === 'submit'
      ? unknownResult(providerLabel, '请求在收到响应前被取消,无法确认上游是否已执行', providerTaskId)
      : {
          kind: 'failed',
          errorCode: ERROR_CODES.UPSTREAM_TIMEOUT,
          message: formatUpstreamMessage(providerLabel, undefined, '轮询请求被取消'),
          retryable: true,
          providerTaskId,
        };
  }

  if (phase === 'poll') {
    return {
      kind: 'failed',
      errorCode: ERROR_CODES.UPSTREAM_TIMEOUT,
      message: formatUpstreamMessage(providerLabel, undefined, transport.detail),
      retryable: true,
      providerTaskId,
    };
  }

  return unknownResult(
    providerLabel,
    transport.cause === 'timeout'
      ? `提交请求超时,未收到上游响应:${transport.detail}`
      : `提交请求连接中断,未收到上游响应:${transport.detail}`,
    providerTaskId,
  );
}

/**
 * HTTP 状态码 → 统一失败语义。
 *
 * 分类依据:
 *  - 429:限流,可重试,解析 Retry-After。
 *  - 408:上游自报超时,可重试。
 *  - 401 / 403 / 402:凭据或余额问题,重试无意义。
 *  - 400 / 422:参数不合法,重试无意义(必须人工修配置或提示用户)。
 *  - 5xx:
 *      · poll 阶段一律可重试(只读查询)。
 *      · submit 阶段若上游给出了结构化错误体(说明请求被上游业务逻辑明确拒绝,
 *        没有产出也通常不计费)→ UPSTREAM_ERROR 且可重试;
 *      · submit 阶段没有可解析错误体(典型的网关 502/503/504、空 body 500)→
 *        无法确认上游是否已执行 → UPSTREAM_RESULT_UNKNOWN 且不可重试。
 */
export function classifyHttpFailure(args: {
  phase: CallPhase;
  providerLabel: string;
  response: HttpResponse;
  /** 各家适配器从响应体里抽取出的可读错误描述 */
  upstreamDetail: unknown;
  /** 上游已返回任务号时带上,便于人工核对 */
  providerTaskId?: string;
  /** 上游是否给出了结构化错误体(用于 5xx 的细分判定) */
  hasStructuredError?: boolean;
}): ProviderFailure {
  const { phase, providerLabel, response, upstreamDetail, providerTaskId } = args;
  const status = response.status;
  const base = {
    kind: 'failed' as const,
    message: formatUpstreamMessage(providerLabel, status, upstreamDetail),
    httpStatus: status,
    providerTaskId,
  };

  if (status === 429) {
    return {
      ...base,
      errorCode: ERROR_CODES.UPSTREAM_RATE_LIMITED,
      retryable: true,
      retryAfterSeconds: parseRetryAfterSeconds(response.headers['retry-after']),
    };
  }

  if (status === 408) {
    return { ...base, errorCode: ERROR_CODES.UPSTREAM_TIMEOUT, retryable: true };
  }

  if (status === 401 || status === 402 || status === 403) {
    return { ...base, errorCode: ERROR_CODES.UPSTREAM_ERROR, retryable: false };
  }

  if (status >= 400 && status < 500) {
    return { ...base, errorCode: ERROR_CODES.UPSTREAM_ERROR, retryable: false };
  }

  if (status >= 500) {
    if (phase === 'poll') {
      return { ...base, errorCode: ERROR_CODES.UPSTREAM_ERROR, retryable: true };
    }
    if (args.hasStructuredError === true) {
      return { ...base, errorCode: ERROR_CODES.UPSTREAM_ERROR, retryable: true };
    }
    return {
      ...base,
      errorCode: ERROR_CODES.UPSTREAM_RESULT_UNKNOWN,
      retryable: false,
    };
  }

  // 2xx / 3xx 走到这里说明响应体不符合预期(缺字段、类型不对)
  return { ...base, errorCode: ERROR_CODES.UPSTREAM_ERROR, retryable: false };
}

/** 结果未知的统一构造入口:retryable 恒为 false */
export function unknownResult(providerLabel: string, detail: unknown, providerTaskId?: string): ProviderFailure {
  return {
    kind: 'failed',
    errorCode: ERROR_CODES.UPSTREAM_RESULT_UNKNOWN,
    message: formatUpstreamMessage(providerLabel, undefined, detail),
    retryable: false,
    providerTaskId,
  };
}

/** 上游返回 2xx 但响应体结构不符合文档时使用 */
export function malformedResponse(providerLabel: string, detail: unknown, httpStatus?: number): ProviderFailure {
  return {
    kind: 'failed',
    errorCode: ERROR_CODES.UPSTREAM_ERROR,
    message: formatUpstreamMessage(providerLabel, httpStatus, `上游响应结构与文档不符:${String(detail)}`),
    retryable: false,
    httpStatus,
  };
}

export function contentBlockedFailure(providerLabel: string, detail: unknown, httpStatus?: number): ProviderFailure {
  return {
    kind: 'failed',
    errorCode: ERROR_CODES.CONTENT_BLOCKED_OUTPUT,
    message: formatUpstreamMessage(providerLabel, httpStatus, detail),
    retryable: false,
    httpStatus,
  };
}

/** 供 testConnection 复用:把 ProviderFailure 里的 errorCode 透出 */
export function failureToErrorCode(failure: ProviderFailure): ErrorCode {
  return failure.errorCode;
}
