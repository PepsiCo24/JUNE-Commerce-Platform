import { ERROR_CODES } from '@june/shared';

import { ApiError } from '@/lib/api/errors';

import {
  describeConcurrencyLimit,
  describeWithOverrides,
  isCode,
  SUBMIT_ERROR_COPY,
} from './error-copy';

export function fieldErrorsFromZod(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_form';
    if (!(key in map)) map[key] = issue.message;
  }
  return map;
}

export function describeSubmitError(
  error: unknown,
  concurrency?: { running?: number; pending?: number; imagePerUserRunning?: number; imagePerUserPending?: number },
): string {
  if (isCode(error, ERROR_CODES.USER_CONCURRENCY_LIMIT)) {
    const running = concurrency?.running ?? concurrency?.imagePerUserRunning;
    const pending = concurrency?.pending ?? concurrency?.imagePerUserPending;
    return describeConcurrencyLimit(
      error,
      running !== undefined && pending !== undefined ? { running, pending } : undefined,
    );
  }
  return describeWithOverrides(error, SUBMIT_ERROR_COPY);
}

export function fieldErrorsFromApi(error: unknown): Record<string, string> {
  return error instanceof ApiError ? error.fieldErrors : {};
}

/** 空字符串交给后端的 nullable 字段 */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
