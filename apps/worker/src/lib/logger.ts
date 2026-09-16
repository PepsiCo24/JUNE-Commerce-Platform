/**
 * 极简分级日志。Worker 是纯 Node 进程,不引入 Nest 的 Logger。
 *
 * 安全约定(docs/CONVENTIONS.md §11):
 *  - 绝不写入供应商 API Key、内部系统提示词、店铺密码;
 *  - 上游错误文案统一由 @june/providers 的 sanitizeUpstreamMessage 脱敏后才允许落日志;
 *  - 用户生成的正文内容不整段打印,只打印长度与命中片段掩码。
 */
import { loadEnv } from '../config/env';

const LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3, verbose: 4 } as const;
export type LogLevel = keyof typeof LEVEL_ORDER;

let threshold: number | null = null;

function enabled(level: LogLevel): boolean {
  if (threshold === null) {
    // 日志级别读取失败时保守输出到 info,不让日志系统本身成为启动失败点
    try {
      threshold = LEVEL_ORDER[loadEnv().LOG_LEVEL];
    } catch {
      threshold = LEVEL_ORDER.info;
    }
  }
  return LEVEL_ORDER[level] <= threshold;
}

function emit(level: LogLevel, scope: string, message: string): void {
  if (!enabled(level)) return;
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  error(message: string, err?: unknown): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  verbose(message: string): void;
}

export function createLogger(scope: string): Logger {
  return {
    error(message, err) {
      const detail = err instanceof Error ? `${message}: ${err.message}` : message;
      emit('error', scope, detail);
      if (err instanceof Error && err.stack && enabled('debug')) {
        emit('debug', scope, err.stack);
      }
    },
    warn: (message) => emit('warn', scope, message),
    info: (message) => emit('info', scope, message),
    debug: (message) => emit('debug', scope, message),
    verbose: (message) => emit('verbose', scope, message),
  };
}

/** 兜底截断,避免把上游整段响应写进日志 */
export function truncate(value: string, max = 300): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(共 ${value.length} 字)`;
}
