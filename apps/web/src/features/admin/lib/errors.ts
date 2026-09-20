import { ERROR_CODES } from '@june/shared';
import { toast } from 'sonner';

import { ApiError, describeError } from '@/lib/api/errors';

/**
 * 管理站的错误文案。
 *
 * 一律按 `code` 分支(契约要求),不匹配文案。只有在管理站语境下比通用文案更明确的
 * 错误码才在这里覆盖,其余交给 `describeError`。
 */
const ADMIN_MESSAGES: Record<string, string> = {
  [ERROR_CODES.LAST_SUPER_ADMIN]: '不能删除或禁用最后一个超级管理员',
  [ERROR_CODES.ADMIN_REQUIRED]: '该账号不是管理员',
  [ERROR_CODES.PROVIDER_URL_NOT_ALLOWED]:
    'API 地址被拒绝:仅允许公网 HTTPS 地址,内网、回环与云元数据地址不被接受',
  [ERROR_CODES.FORBIDDEN]: '当前管理员没有执行该操作的权限',
  [ERROR_CODES.CSRF_FAILED]: '安全校验失败,请刷新页面后再试(不要用过期标签页提交)',
};

export function adminErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const override = ADMIN_MESSAGES[error.code];
    if (override) return override;
  }
  return describeError(error);
}

/** 统一的失败提示。带 requestId 时一并展示,便于对照服务端日志。 */
export function toastApiError(error: unknown, fallbackTitle = '操作失败'): void {
  const message = adminErrorMessage(error);
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  toast.error(fallbackTitle, {
    description: requestId ? `${message}(请求 ID:${requestId})` : message,
  });
}

/** 字段级错误回填。表单用 `ApiError.fieldErrors` 定位到具体输入框。 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  return error instanceof ApiError ? error.fieldErrors : {};
}

export function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}
