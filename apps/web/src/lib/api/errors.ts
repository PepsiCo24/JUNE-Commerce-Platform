import { ERROR_CODES, ERROR_MESSAGES, type ApiErrorBody, type ErrorCode } from '@june/shared';

/**
 * 统一 API 错误。
 *
 * 约定:前端一律通过 `code` 做分支判断,禁止匹配错误文案(文案会随本地化调整)。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | string;
  readonly details: Array<{ path: string; message: string }>;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(params: {
    status: number;
    code: ErrorCode | string;
    message: string;
    details?: Array<{ path: string; message: string }>;
    requestId?: string;
    retryAfterSeconds?: number;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code;
    this.details = params.details ?? [];
    this.requestId = params.requestId;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }

  /** 字段级错误转成表单可直接使用的映射 */
  get fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const item of this.details) {
      if (!(item.path in map)) map[item.path] = item.message;
    }
    return map;
  }

  /** 登录状态问题:需要跳转登录页 */
  get isAuthError(): boolean {
    return (
      this.code === ERROR_CODES.UNAUTHENTICATED ||
      this.code === ERROR_CODES.SESSION_EXPIRED ||
      this.code === ERROR_CODES.ACCOUNT_DISABLED
    );
  }

  /** 需要重新验证身份(查看店铺密码) */
  get needsReauth(): boolean {
    return this.code === ERROR_CODES.REAUTH_REQUIRED || this.code === ERROR_CODES.REAUTH_INVALID;
  }

  /**
   * 是否值得自动重试。
   * 注意:上游结果未知(UPSTREAM_RESULT_UNKNOWN)绝不自动重试,避免重复计费。
   */
  get isRetryable(): boolean {
    if (this.code === ERROR_CODES.UPSTREAM_RESULT_UNKNOWN) return false;
    if (this.status === 408 || this.status === 429) return true;
    return this.status >= 500 && this.status < 600;
  }
}

/** 网络不可达 / 请求被中断:与业务错误区分,便于展示"重试"而不是"检查输入" */
export class NetworkError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/** 把后端错误体转成 ApiError;响应体异常时兜底为通用错误 */
export function toApiError(status: number, body: unknown, fallbackRequestId?: string): ApiError {
  const parsed = body as ApiErrorBody | undefined;
  const error = parsed?.error;

  if (error && typeof error.code === 'string') {
    return new ApiError({
      status,
      code: error.code,
      message: error.message || ERROR_MESSAGES[error.code as ErrorCode] || '请求失败',
      details: error.details,
      requestId: error.requestId ?? fallbackRequestId,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }

  const fallbackCode: ErrorCode =
    status === 401
      ? ERROR_CODES.UNAUTHENTICATED
      : status === 403
        ? ERROR_CODES.FORBIDDEN
        : status === 404
          ? ERROR_CODES.NOT_FOUND
          : status === 429
            ? ERROR_CODES.RATE_LIMITED
            : status >= 500
              ? ERROR_CODES.INTERNAL_ERROR
              : ERROR_CODES.VALIDATION_FAILED;

  return new ApiError({
    status,
    code: fallbackCode,
    message: ERROR_MESSAGES[fallbackCode] ?? '请求失败',
    requestId: fallbackRequestId,
  });
}

/** 任意异常转成可展示的中文文案 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof NetworkError) return '网络连接异常,请检查网络后重试';
  if (error instanceof Error && error.name === 'AbortError') return '请求已取消';
  if (error instanceof Error) return error.message || '发生未知错误';
  return '发生未知错误';
}
