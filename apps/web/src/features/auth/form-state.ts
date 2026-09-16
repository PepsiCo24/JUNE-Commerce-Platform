'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ZodType } from 'zod';

import { ApiError, describeError } from '@/lib/api/errors';

/**
 * 认证类表单的共用状态机:提交中 / 字段错误 / 整表错误 / 限流倒计时。
 *
 * 校验规则一律复用 `@june/shared` 里的 zod schema(与后端同一份定义),
 * 这里只负责把校验结果与后端返回的 `ApiError.fieldErrors` 归一到同一份 `fieldErrors`。
 */

export type FieldErrors = Record<string, string>;

/** 把 zod 的 issues 展平成「字段名 → 第一条错误」 */
export function zodFieldErrors(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): FieldErrors {
  const map: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_form';
    if (!(key in map)) map[key] = issue.message;
  }
  return map;
}

export interface SubmitOptions {
  /** 按错误码覆盖提示文案。例如登录失败统一提示,不暴露是邮箱还是密码错 */
  messages?: Record<string, string>;
  /**
   * 这些错误码下忽略后端的字段级错误。
   * 用于防用户枚举:登录失败时不能把错误标注在「邮箱」上,否则等于确认该邮箱存在。
   */
  ignoreFieldErrorsFor?: string[];
}

export interface AuthFormState {
  submitting: boolean;
  formError: string | null;
  fieldErrors: FieldErrors;
  /** 限流剩余秒数,大于 0 时禁止提交 */
  retryAfterSeconds: number;
  setFieldErrors: (errors: FieldErrors) => void;
  setFormError: (message: string | null) => void;
  clearErrors: () => void;
  /** 清掉单个字段的错误(用户开始修改时调用) */
  clearFieldError: (field: string) => void;
  /**
   * 执行一次提交。先跑 zod 校验,失败直接回填字段错误;
   * 通过后执行 `action`,捕获 ApiError 并归类。返回是否成功。
   */
  submit: <Input>(params: {
    schema: ZodType<Input>;
    values: unknown;
    action: (input: Input) => Promise<void>;
    options?: SubmitOptions;
  }) => Promise<boolean>;
}

export function useAuthFormState(): AuthFormState {
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);

  // 组件卸载后不再 setState(提交过程中用户可能已经跳走)
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 限流倒计时:每秒递减到 0
  useEffect(() => {
    if (retryAfterSeconds <= 0) return;
    const timer = setInterval(() => {
      setRetryAfterSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAfterSeconds]);

  const clearErrors = useCallback(() => {
    setFormError(null);
    setFieldErrors({});
  }, []);

  const clearFieldError = useCallback((field: string) => {
    setFieldErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const submit = useCallback<AuthFormState['submit']>(async ({ schema, values, action, options }) => {
    setFormError(null);
    setFieldErrors({});

    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setFieldErrors(zodFieldErrors(parsed.error));
      return false;
    }

    setSubmitting(true);
    try {
      await action(parsed.data);
      return true;
    } catch (error) {
      if (!mountedRef.current) return false;

      if (error instanceof ApiError) {
        const override = options?.messages?.[String(error.code)];
        const ignoreFields = options?.ignoreFieldErrorsFor?.includes(String(error.code)) ?? false;

        if (!ignoreFields) {
          const backendFieldErrors = error.fieldErrors;
          if (Object.keys(backendFieldErrors).length > 0) setFieldErrors(backendFieldErrors);
        }

        if (error.code === 'RATE_LIMITED') {
          // 后端没给建议间隔时按 60 秒兜底,倒计时期间禁用提交
          setRetryAfterSeconds(error.retryAfterSeconds && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60);
        }

        setFormError(override ?? error.message);
        return false;
      }

      setFormError(describeError(error));
      return false;
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, []);

  return useMemo(
    () => ({
      submitting,
      formError,
      fieldErrors,
      retryAfterSeconds,
      setFieldErrors,
      setFormError,
      clearErrors,
      clearFieldError,
      submit,
    }),
    [submitting, formError, fieldErrors, retryAfterSeconds, clearErrors, clearFieldError, submit],
  );
}
