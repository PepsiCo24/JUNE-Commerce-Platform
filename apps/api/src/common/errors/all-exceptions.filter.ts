import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@june/db';
import { ERROR_CODES, ERROR_MESSAGES, type ApiErrorBody } from '@june/shared';
import type { Request, Response } from 'express';

import { AppException } from './app-exception';

/**
 * 统一异常处理。
 *
 * 三条硬性要求:
 *  1. 响应体格式统一为 ApiErrorBody,始终带机器可读 code。
 *  2. 对外不泄漏内部细节:数据库约束名、SQL、堆栈、文件路径一律不进响应。
 *  3. 日志脱敏:请求体中的 password / apiKey / secret / token 字段在记录前替换掉。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as Request & { requestId?: string }).requestId ?? '-';

    // SSE 连接已经开始流式输出时不能再写 JSON 响应体
    if (response.headersSent) {
      this.logger.error(
        `[${requestId}] 响应已开始输出后发生异常:${this.describe(exception)}`,
        this.stackOf(exception),
      );
      response.end();
      return;
    }

    const mapped = this.map(exception);

    const body: ApiErrorBody = {
      error: {
        code: mapped.code,
        message: mapped.message,
        requestId,
        ...(mapped.details ? { details: mapped.details } : {}),
        ...(mapped.retryAfterSeconds ? { retryAfterSeconds: mapped.retryAfterSeconds } : {}),
      },
    };

    if (mapped.retryAfterSeconds) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }

    const logLine =
      `[${requestId}] ${request.method} ${request.originalUrl} -> ${mapped.status} ` +
      `${mapped.code}${mapped.logDetail ? ` | ${mapped.logDetail}` : ''}`;

    if (mapped.status >= 500) {
      this.logger.error(logLine, this.stackOf(exception));
      if (mapped.logContext) {
        this.logger.error(`[${requestId}] 上下文:${JSON.stringify(this.redact(mapped.logContext))}`);
      }
    } else if (mapped.status === 429) {
      this.logger.warn(logLine);
    } else {
      this.logger.debug(logLine);
    }

    response.status(mapped.status).json(body);
  }

  private map(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: Array<{ path: string; message: string }>;
    retryAfterSeconds?: number;
    logDetail?: string;
    logContext?: Record<string, unknown>;
  } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: this.messageOf(exception),
        details: exception.details,
        retryAfterSeconds: exception.retryAfterSeconds,
        logContext: exception.logContext,
      };
    }

    // Nest 内置异常(404 路由未匹配、限流守卫等)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const fallbackCode =
        status === HttpStatus.NOT_FOUND
          ? ERROR_CODES.NOT_FOUND
          : status === HttpStatus.TOO_MANY_REQUESTS
            ? ERROR_CODES.RATE_LIMITED
            : status === HttpStatus.UNAUTHORIZED
              ? ERROR_CODES.UNAUTHENTICATED
              : status === HttpStatus.FORBIDDEN
                ? ERROR_CODES.FORBIDDEN
                : status >= 500
                  ? ERROR_CODES.INTERNAL_ERROR
                  : ERROR_CODES.VALIDATION_FAILED;

      const nested =
        typeof res === 'object' && res !== null && 'error' in res
          ? (res as { error?: { code?: string; message?: string } }).error
          : undefined;

      return {
        status,
        code: nested?.code ?? fallbackCode,
        message: nested?.message ?? ERROR_MESSAGES[fallbackCode] ?? '请求处理失败',
      };
    }

    // Prisma 已知错误:映射为业务语义,不回传约束名等内部细节
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.CONFLICT,
            message: '该内容已存在,请勿重复提交',
            logDetail: `unique violation on ${JSON.stringify(exception.meta?.target ?? null)}`,
          };
        case 'P2003':
          return {
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.CONFLICT,
            message: '关联数据不存在或仍被引用',
            logDetail: 'foreign key violation',
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            code: ERROR_CODES.NOT_FOUND,
            message: ERROR_MESSAGES[ERROR_CODES.NOT_FOUND] ?? '内容不存在',
          };
        default:
          return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            code: ERROR_CODES.INTERNAL_ERROR,
            message: ERROR_MESSAGES[ERROR_CODES.INTERNAL_ERROR] ?? '服务异常',
            logDetail: `prisma ${exception.code}`,
          };
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ERROR_CODES.INTERNAL_ERROR,
        message: ERROR_MESSAGES[ERROR_CODES.INTERNAL_ERROR] ?? '服务异常',
        logDetail: 'prisma validation error',
      };
    }

    // 数据库/Redis 连接类故障 -> 503,便于前端提示"稍后重试"而不是"数据有误"
    const msg = exception instanceof Error ? exception.message : String(exception);
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection terminated|pool/i.test(msg)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ERROR_CODES.SERVICE_UNAVAILABLE,
        message: ERROR_MESSAGES[ERROR_CODES.SERVICE_UNAVAILABLE] ?? '服务暂时不可用',
        logDetail: 'infrastructure connectivity',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: ERROR_MESSAGES[ERROR_CODES.INTERNAL_ERROR] ?? '服务异常',
    };
  }

  private messageOf(exception: AppException): string {
    const res = exception.getResponse();
    if (typeof res === 'object' && res !== null && 'error' in res) {
      const inner = (res as { error?: { message?: string } }).error;
      if (inner?.message) return inner.message;
    }
    return '请求处理失败';
  }

  private describe(exception: unknown): string {
    return exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception);
  }

  private stackOf(exception: unknown): string | undefined {
    return exception instanceof Error ? exception.stack : undefined;
  }

  /** 日志脱敏:任何看起来像凭据的字段都不落盘 */
  private redact(input: Record<string, unknown>): Record<string, unknown> {
    const sensitive = /password|secret|token|apikey|api_key|credential|authorization|cookie/i;
    const walk = (value: unknown, depth = 0): unknown => {
      if (depth > 4) return '[deep]';
      if (Array.isArray(value)) return value.slice(0, 20).map((v) => walk(v, depth + 1));
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = sensitive.test(k) ? '[redacted]' : walk(v, depth + 1);
        }
        return out;
      }
      return value;
    };
    return walk(input) as Record<string, unknown>;
  }
}
