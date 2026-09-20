'use client';

import { BrandLogo } from '@june/brand';
import { adminLoginSchema, BRAND_FULL_NAME, type SessionUser } from '@june/shared';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { FormAlert } from '@/features/auth/form-alert';
import { useAuthFormState } from '@/features/auth/form-state';
import { PasswordInput } from '@/features/auth/password-input';
import { adminApi } from '@/features/admin/api/client';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import { sanitizeAdminRedirect } from '@/features/admin/lib/redirect';
import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

const ERROR_COPY: Record<string, string> = {
  credentials: '邮箱或密码不正确',
  required: '请填写邮箱和密码',
  invalid: '提交内容无效,请重试',
  network: '网络异常,请稍后重试',
  rate_limited: '尝试过于频繁,请稍后再试',
};

/** 无 JS / hydrate 失败时的原生 POST 回退入口 */
const NATIVE_SUBMIT_ACTION = '/admin/login/submit';

export function AdminLoginForm(): React.JSX.Element {
  const searchParams = useSearchParams();
  const { refresh, user, isLoading } = useAdminAuth();
  const form = useAuthFormState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const redirectTo = sanitizeAdminRedirect(searchParams.get('redirect'));
  const queryError = useMemo(() => {
    const code = searchParams.get('error');
    return code ? (ERROR_COPY[code] ?? '登录失败,请重试') : null;
  }, [searchParams]);

  // 已有有效会话时直接进控制台
  useEffect(() => {
    if (!isLoading && user) {
      window.location.replace(redirectTo);
    }
  }, [isLoading, user, redirectTo]);

  return (
    <div className="w-full">
      <div className="mb-7 flex justify-center">
        <BrandLogo variant="full" theme="dark" size="xl" className="h-auto w-[min(13rem,68vw)]" title={BRAND_FULL_NAME} />
      </div>

      <div className="june-glass rounded-2xl p-6 sm:p-8">
        <h1 className="text-lg font-semibold text-fg">管理站登录</h1>
        <p className="mt-1.5 text-sm text-fg-muted">独立会话,与社区 / 工作台互不通用。</p>

        <form
          method="post"
          action={NATIVE_SUBMIT_ACTION}
          // 关闭浏览器原生校验气泡(深色自定义样式下经常看不见)
          noValidate
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            // JS 可用时走客户端 API;并从 FormData 取值,兼容浏览器自动填充未触发 onChange 的情况
            event.preventDefault();
            const fd = new FormData(event.currentTarget);
            const values = {
              email: String(fd.get('email') ?? email).trim(),
              password: String(fd.get('password') ?? password),
            };
            setEmail(values.email);
            setPassword(values.password);
            void form.submit({
              schema: adminLoginSchema,
              values,
              options: {
                messages: {
                  INVALID_CREDENTIALS: ERROR_COPY.credentials,
                  RATE_LIMITED: ERROR_COPY.rate_limited,
                  CSRF_FAILED: '安全校验失败,请刷新页面后重试',
                },
                ignoreFieldErrorsFor: ['INVALID_CREDENTIALS'],
              },
              action: async (input) => {
                await adminApi.post<SessionUser>(ADMIN_PATHS.auth.login, input);
                const session = await refresh();
                if (!session) {
                  throw new Error('登录成功但未能建立会话,请刷新页面后重试');
                }
                window.location.assign(redirectTo);
              },
            });
          }}
        >
          {form.formError || queryError ? <FormAlert>{form.formError ?? queryError}</FormAlert> : null}
          <Field label="邮箱" htmlFor="admin-login-email" required error={form.fieldErrors.email}>
            <Input
              id="admin-login-email"
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              invalid={Boolean(form.fieldErrors.email)}
              onChange={(event) => {
                setEmail(event.target.value);
                form.clearFieldError('email');
                form.setFormError(null);
              }}
            />
          </Field>
          <Field label="密码" htmlFor="admin-login-password" required error={form.fieldErrors.password}>
            <PasswordInput
              id="admin-login-password"
              name="password"
              value={password}
              invalid={Boolean(form.fieldErrors.password)}
              onChange={(value) => {
                setPassword(value);
                form.clearFieldError('password');
                form.setFormError(null);
              }}
              autoComplete="current-password"
            />
          </Field>
          <Button type="submit" fullWidth loading={form.submitting} disabled={form.retryAfterSeconds > 0}>
            {form.retryAfterSeconds > 0 ? `${form.retryAfterSeconds} 秒后可重试` : '登录'}
          </Button>
        </form>
      </div>

      <p className="mt-6 text-center text-xs text-fg-subtle">{BRAND_FULL_NAME}</p>
    </div>
  );
}
