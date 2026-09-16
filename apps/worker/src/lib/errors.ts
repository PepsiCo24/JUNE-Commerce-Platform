/**
 * 上游错误分类。这是整个 Worker 最需要谨慎的一段逻辑:
 * **分类错了就会重复调用付费接口,或者把已经出图的任务判成失败。**
 *
 * 分类表(taskStatus 指写入 GenerationTask.status):
 *
 * | 情形                                    | taskStatus | errorCode                | 自动重试 |
 * |-----------------------------------------|------------|--------------------------|----------|
 * | HTTP 429 / 适配器报 UPSTREAM_RATE_LIMITED | 保持 RUNNING→重排 | UPSTREAM_RATE_LIMITED | 是(退避重排,不计失败) |
 * | 提交阶段超时 / 连接中断(可能已计费)      | UNKNOWN    | UPSTREAM_TIMEOUT         | **否**   |
 * | 轮询次数耗尽(已提交成功,拿到 providerTaskId) | UNKNOWN | UPSTREAM_TIMEOUT      | **否**   |
 * | 适配器明确返回 UPSTREAM_RESULT_UNKNOWN    | UNKNOWN    | UPSTREAM_RESULT_UNKNOWN  | **否**   |
 * | 5xx 但上游已建任务(带 providerTaskId)     | UNKNOWN    | UPSTREAM_RESULT_UNKNOWN  | **否**   |
 * | 明确的 4xx 参数/鉴权/审核错误              | FAILED     | 沿用适配器 errorCode      | 否(retryable=false) |
 * | 5xx(未建任务)                           | FAILED     | UPSTREAM_ERROR           | 可重试(retryable=true,由用户或运维触发) |
 * | 轮询过程中单次请求失败(轮询本身不计费)     | 继续轮询/重排 | UPSTREAM_ERROR         | 是       |
 *
 * 之所以把"提交阶段超时"和"轮询耗尽"都判成 UNKNOWN 而不是 TIMEOUT:
 *   这两种情况下上游很可能已经执行并计费,只是我们没读到结果。
 *   docs/CONVENTIONS.md §11 明确要求"结果未知时先核对(状态 UNKNOWN)",
 *   errorCode 仍然写 UPSTREAM_TIMEOUT 以保留"是超时导致的"这一事实,
 *   由 maintenance 的 reconcile_unknown_tasks 拿 providerTaskId 去上游核对后再落终态。
 *   只有"从未触达上游"的超时(例如任务整体超时但一次都没提交)才判 TIMEOUT。
 */
import { ERROR_CODES, backoffDelayMs, type ErrorCode } from '@june/shared';

import type { ProviderFailure } from './provider-contract';

/** 出错发生在哪个环节。决定"上游是否可能已经计费"。 */
export type FailurePhase =
  /** 提交调用本身失败 */
  | 'submit'
  /** 异步供应商的单次轮询请求失败(轮询不计费,可安全重试) */
  | 'poll'
  /** 轮询次数/时间耗尽,上游始终没给终态 */
  | 'poll_exhausted'
  /** 任务整体超时且从未成功提交过任何上游调用 */
  | 'never_submitted_timeout';

export interface ClassifyInput {
  failure: Pick<ProviderFailure, 'errorCode' | 'message' | 'retryable'> &
    Partial<Pick<ProviderFailure, 'httpStatus' | 'providerTaskId' | 'retryAfterSeconds'>>;
  phase: FailurePhase;
  /** 当前是这个任务的第几次尝试(用于指数退避) */
  attempt: number;
  /** 已知的上游任务号(适配器没带出来时由调用方补上) */
  providerTaskId?: string | null;
}

export type Disposition =
  | {
      action: 'retry_later';
      /** 延迟多久重新入队 */
      delayMs: number;
      errorCode: ErrorCode;
      message: string;
      /** 限流不计入失败次数,不该让用户看到"失败" */
      countsAsFailure: false;
    }
  | {
      action: 'mark_unknown';
      taskStatus: 'UNKNOWN';
      errorCode: ErrorCode;
      message: string;
      /** 结果未知恒为 false:可能已计费,禁止盲目重试 */
      retryable: false;
      providerTaskId: string | null;
    }
  | {
      action: 'fail';
      taskStatus: 'FAILED' | 'TIMEOUT';
      errorCode: ErrorCode;
      message: string;
      retryable: boolean;
    };

/** 限流退避上限,避免 Retry-After 给了个离谱的值把任务压到明天 */
export const MAX_RETRY_DELAY_MS = 10 * 60_000;

export function classifyUpstreamFailure(input: ClassifyInput): Disposition {
  const { failure, phase, attempt } = input;
  const providerTaskId = input.providerTaskId ?? failure.providerTaskId ?? null;
  const status = failure.httpStatus;
  const message = failure.message;

  // 1. 适配器已经判定"结果未知":直接尊重,不再二次推断
  if (failure.errorCode === ERROR_CODES.UPSTREAM_RESULT_UNKNOWN) {
    return unknownDisposition(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN, message, providerTaskId);
  }

  // 2. 限流:退避重排,不算失败
  if (status === 429 || failure.errorCode === ERROR_CODES.UPSTREAM_RATE_LIMITED) {
    const fromHeader =
      typeof failure.retryAfterSeconds === 'number' && failure.retryAfterSeconds > 0
        ? failure.retryAfterSeconds * 1000
        : null;
    return {
      action: 'retry_later',
      delayMs: Math.min(MAX_RETRY_DELAY_MS, fromHeader ?? backoffDelayMs(attempt)),
      errorCode: ERROR_CODES.UPSTREAM_RATE_LIMITED,
      message,
      countsAsFailure: false,
    };
  }

  // 3. 超时 / 连接中断
  const isTimeout = failure.errorCode === ERROR_CODES.UPSTREAM_TIMEOUT || status === 408;
  if (phase === 'never_submitted_timeout') {
    // 一次上游调用都没发出去,不可能计费,可以放心判超时
    return {
      action: 'fail',
      taskStatus: 'TIMEOUT',
      errorCode: ERROR_CODES.UPSTREAM_TIMEOUT,
      message,
      retryable: true,
    };
  }
  if (phase === 'poll_exhausted') {
    // 已提交成功(有 providerTaskId),上游大概率已经计费 → 必须核对而不是重试
    return unknownDisposition(ERROR_CODES.UPSTREAM_TIMEOUT, message, providerTaskId);
  }
  if (isTimeout) {
    if (phase === 'submit') {
      // 提交阶段超时:请求可能已经到达上游并被执行,绝不自动重试
      return unknownDisposition(ERROR_CODES.UPSTREAM_TIMEOUT, message, providerTaskId);
    }
    // 轮询阶段的单次超时:轮询是只读且免费的,继续退避重试
    return {
      action: 'retry_later',
      delayMs: Math.min(MAX_RETRY_DELAY_MS, backoffDelayMs(attempt)),
      errorCode: ERROR_CODES.UPSTREAM_TIMEOUT,
      message,
      countsAsFailure: false,
    };
  }

  // 4. 明确的 4xx:参数/鉴权/审核错误,重试没有意义
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return {
      action: 'fail',
      taskStatus: 'FAILED',
      errorCode: failure.errorCode,
      message,
      retryable: false,
    };
  }

  // 5. 5xx:上游自己出错
  if (typeof status === 'number' && status >= 500) {
    if (providerTaskId) {
      // 任务已经在上游建好了,后续调用挂掉不代表没执行 → 核对
      return unknownDisposition(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN, message, providerTaskId);
    }
    return {
      action: 'fail',
      taskStatus: 'FAILED',
      errorCode: ERROR_CODES.UPSTREAM_ERROR,
      message,
      retryable: true,
    };
  }

  // 6. 没有 HTTP 状态码的其他错误:尊重适配器给的 retryable
  if (phase === 'poll') {
    return {
      action: 'retry_later',
      delayMs: Math.min(MAX_RETRY_DELAY_MS, backoffDelayMs(attempt)),
      errorCode: failure.errorCode,
      message,
      countsAsFailure: false,
    };
  }
  return {
    action: 'fail',
    taskStatus: 'FAILED',
    errorCode: failure.errorCode,
    message,
    retryable: failure.retryable,
  };
}

function unknownDisposition(
  errorCode: ErrorCode,
  message: string,
  providerTaskId: string | null,
): Disposition {
  return {
    action: 'mark_unknown',
    taskStatus: 'UNKNOWN',
    errorCode,
    message,
    retryable: false,
    providerTaskId,
  };
}

// ---------------------------------------------------------------------------
// 把抛出的异常规整成 ProviderFailure,保证所有错误都走同一套分类
// ---------------------------------------------------------------------------

const ABORT_NAMES = new Set(['AbortError', 'TimeoutError']);
const NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * 适配器不该抛异常(契约里失败也是返回值),但 fetch 层的 AbortError、
 * DNS 失败等仍可能穿透。这里统一收敛:
 * 超时/连接中断一律当作 UPSTREAM_TIMEOUT,交给 classifyUpstreamFailure 按阶段判断。
 */
export function toProviderFailure(err: unknown, fallbackMessage = '上游调用异常'): ProviderFailure {
  const error = err instanceof Error ? err : new Error(String(err));
  const name = error.name;
  const code = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause;

  const looksLikeTimeout =
    ABORT_NAMES.has(name) ||
    (code ? NETWORK_CODES.has(code) : false) ||
    (cause?.code ? NETWORK_CODES.has(cause.code) : false);

  return {
    kind: 'failed',
    errorCode: looksLikeTimeout ? ERROR_CODES.UPSTREAM_TIMEOUT : ERROR_CODES.UPSTREAM_ERROR,
    // 异常 message 可能带上游回显内容,统一截断;适配层的正常失败路径已经脱敏过
    message: `${fallbackMessage}:${error.message}`.slice(0, 400),
    retryable: looksLikeTimeout,
  };
}

/** 明确失败(不涉及上游计费)的构造助手,例如模型被停用、凭据缺失 */
export function localFailure(errorCode: ErrorCode, message: string): ProviderFailure {
  return { kind: 'failed', errorCode, message, retryable: false };
}
