'use client';

import { BrandLogo } from '@june/brand';
import { adminLoginSchema, BRAND_FULL_NAME } from '@june/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { FormAlert } from '@/features/auth/form-alert';
import { useAuthFormState } from '@/features/auth/form-state';
import { PasswordInput } from '@/features/auth/password-input';
import { adminApi } from '@/features/admin/api/client';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import { sanitizeAdminRedirect } from '@/features/admin/lib/redirect';
import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

export function AdminLoginForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh, user, isLoading } = useAdminAuth();
  const form = useAuthFormState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const redirectTo = sanitizeAdminRedirect(searchParams.get('redirect'));

  useEffect(() => {
    if (!isLoading && user) {
      router.replace(redirectTo);
    }
  }, [isLoading, user, redirectTo, router]);

  return (
    <div className="w-full">
      <div className="mb-7 flex justify-center">
        <BrandLogo variant="full" theme="dark" size="xl" className="h-auto w-[min(13rem,68vw)]" title={BRAND_FULL_NAME} />
      </div>

      <div className="june-glass rounded-2xl p-6 sm:p-8">
        <h1 className="text-lg font-semibold text-fg">管理站登录</h1>
        <p className="mt-1.5 text-sm text-fg-muted">独立会话,与社区 / 工作台互不通用。</p>

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit({
              schema: adminLoginSchema,
              values: { email, password },
              options: {
                messages: { INVALID_CREDENTIALS: '邮箱或密码不正确' },
                ignoreFieldErrorsFor: ['INVALID_CREDENTIALS'],
              },
              action: async (input) => {
                await adminApi.post(ADMIN_PATHS.auth.login, input);
                await refresh();
                router.replace(redirectTo);
                router.refresh();
              },
            });
          }}
        >
          {form.formError ? <FormAlert>{form.formError}</FormAlert> : null}
          <Field label="邮箱" htmlFor="admin-login-email" required error={form.fieldErrors.email}>
            <Input
              id="admin-login-email"
              type="email"
              autoComplete="username"
              value={email}
              invalid={Boolean(form.fieldErrors.email)}
              onChange={(event) => {
                setEmail(event.target.value);
                form.clearFieldError('email');
              }}
            />
          </Field>
          <Field label="密码" htmlFor="admin-login-password" required error={form.fieldErrors.password}>
            <PasswordInput
              id="admin-login-password"
              value={password}
              invalid={Boolean(form.fieldErrors.password)}
              onChange={(value) => {
                setPassword(value);
                form.clearFieldError('password');
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
