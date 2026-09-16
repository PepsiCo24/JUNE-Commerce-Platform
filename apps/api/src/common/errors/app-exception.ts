import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, ERROR_MESSAGES, type ErrorCode } from '@june/shared';

export interface AppExceptionOptions {
  /** 字段级错误明细 */
  details?: Array<{ path: string; message: string }>;
  /** 限流场景的建议重试间隔 */
  retryAfterSeconds?: number;
  /** 只写入服务端日志、不返回给客户端的上下文 */
  logContext?: Record<string, unknown>;
}

/**
 * 业务异常。始终携带机器可读的错误码,前端据此分支处理,不依赖文案匹配。
 * message 面向用户且已脱敏;敏感上下文放 logContext,只进日志不进响应。
 */
export class AppException extends HttpException {
  readonly code: ErrorCode | string;
  readonly details?: Array<{ path: string; message: string }>;
  readonly retryAfterSeconds?: number;
  readonly logContext?: Record<string, unknown>;

  constructor(
    code: ErrorCode | string,
    status: HttpStatus,
    message?: string,
    options: AppExceptionOptions = {},
  ) {
    const resolved = message ?? ERROR_MESSAGES[code as ErrorCode] ?? '请求处理失败';
    super({ error: { code, message: resolved } }, status);
    this.code = code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.logContext = options.logContext;
  }

  // -------------------------------------------------------------------------
  // 常用快捷构造器
  // -------------------------------------------------------------------------

  static validation(details: Array<{ path: string; message: string }>, message?: string): AppException {
    return new AppException(ERROR_CODES.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, message, { details });
  }

  static badRequest(code: ErrorCode | string, message?: string, options?: AppExceptionOptions): AppException {
    return new AppException(code, HttpStatus.BAD_REQUEST, message, options);
  }

  static unauthenticated(code: ErrorCode = ERROR_CODES.UNAUTHENTICATED, message?: string): AppException {
    return new AppException(code, HttpStatus.UNAUTHORIZED, message);
  }

  static forbidden(code: ErrorCode = ERROR_CODES.FORBIDDEN, message?: string): AppException {
    return new AppException(code, HttpStatus.FORBIDDEN, message);
  }

  static notFound(message?: string): AppException {
    return new AppException(ERROR_CODES.NOT_FOUND, HttpStatus.NOT_FOUND, message);
  }

  static conflict(code: ErrorCode | string = ERROR_CODES.CONFLICT, message?: string): AppException {
    return new AppException(code, HttpStatus.CONFLICT, message);
  }

  static rateLimited(retryAfterSeconds: number, message?: string): AppException {
    return new AppException(ERROR_CODES.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, message, {
      retryAfterSeconds,
    });
  }

  static payloadTooLarge(message?: string): AppException {
    return new AppException(ERROR_CODES.FILE_TOO_LARGE, HttpStatus.PAYLOAD_TOO_LARGE, message);
  }

  static internal(message?: string, logContext?: Record<string, unknown>): AppException {
    return new AppException(ERROR_CODES.INTERNAL_ERROR, HttpStatus.INTERNAL_SERVER_ERROR, message, {
      logContext,
    });
  }

  static unavailable(message?: string): AppException {
    return new AppException(ERROR_CODES.SERVICE_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE, message);
  }

  /** 资源存在但不属于当前用户。统一返回 404 语义,避免泄漏"资源存在"这一信息。 */
  static notOwner(): AppException {
    return new AppException(
      ERROR_CODES.NOT_FOUND,
      HttpStatus.NOT_FOUND,
      ERROR_MESSAGES[ERROR_CODES.NOT_FOUND],
    );
  }
}
