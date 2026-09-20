'use client';

import { loginSchema, type SessionUser } from '@june/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/toggle';
import { api } from '@/lib/api/client';
import { useAuth } from '@/providers/auth-provider';

import { AuthCard } from './auth-card';
import { FormAlert } from './form-alert';
import { useAuthFormState } from './form-state';
import { PasswordInput } from './password-input';
import { sanitizeRedirect } from './redirect';

const ERROR_COPY: Record<string, string> = {
  credentials: '邮箱或密码不正确',
  required: '请填写邮箱和密码',
  invalid: '提交内容无效,请重试',
  network: '网络异常,请稍后重试',
  rate_limited: '尝试过于频繁,请稍后再试',
};

/** 无 JS / hydrate 失败时的原生 POST 回退 */
const NATIVE_SUBMIT_ACTION = '/login/submit';

export function LoginForm(): React.JSX.Element {
  const searchParams = useSearchParams();
  const { refresh, patchUser } = useAuth();
  const form = useAuthFormState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);

  const redirectTo = sanitizeRedirect(searchParams.get('redirect'));
  const queryError = useMemo(() => {
    const code = searchParams.get('error');
    return code ? (ERROR_COPY[code] ?? '登录失败,请重试') : null;
  }, [searchParams]);

  return (
    <AuthCard
      title="登录"
      description="社区与工作台共用同一账号。"
      footer={
        <p>
          还没有账号？{' '}
          <Link href={`/register?redirect=${encodeURIComponent(redirectTo)}`} className="text-accent hover:underline">
            注册
          </Link>
        </p>
      }
    >
      <form
        method="post"
        action={NATIVE_SUBMIT_ACTION}
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          // JS 可用时走客户端;并从 FormData 取值,兼容自动填充
          event.preventDefault();
          const fd = new FormData(event.currentTarget);
          const values = {
            email: String(fd.get('email') ?? email).trim(),
            password: String(fd.get('password') ?? password),
            remember: fd.get('remember') === 'true' || remember,
          };
          setEmail(values.email);
          setPassword(values.password);
          setRemember(values.remember);
          void form.submit({
            schema: loginSchema,
            values,
            options: {
              messages: {
                INVALID_CREDENTIALS: ERROR_COPY.credentials,
                RATE_LIMITED: ERROR_COPY.rate_limited,
              },
              ignoreFieldErrorsFor: ['INVALID_CREDENTIALS'],
            },
            action: async (input) => {
              const loggedInUser = await api.post<SessionUser>('/auth/login', input);
              patchUser(loggedInUser);
              const session = await refresh();
              if (!session) {
                throw new Error('登录成功但未能建立会话,请刷新页面后重试');
              }
              // 硬跳转:避免 soft nav 在预览/未 hydrate 环境下卡住
              window.location.assign(redirectTo);
            },
          });
        }}
      >
        <input type="hidden" name="redirect" value={redirectTo} />
        <input type="hidden" name="remember" value={remember ? 'true' : 'false'} />

        {form.formError || queryError ? <FormAlert>{form.formError ?? queryError}</FormAlert> : null}

        <Field label="邮箱" htmlFor="login-email" required error={form.fieldErrors.email}>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            invalid={Boolean(form.fieldErrors.email)}
            onChange={(event) => {
              setEmail(event.target.value);
              form.clearFieldError('email');
              form.setFormError(null);
            }}
          />
        </Field>
        <Field label="密码" htmlFor="login-password" required error={form.fieldErrors.password}>
          <PasswordInput
            id="login-password"
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
        <Checkbox
          id="login-remember"
          checked={remember}
          onChange={setRemember}
          label="在这台设备上保持登录"
        />
        <Button type="submit" fullWidth loading={form.submitting} disabled={form.retryAfterSeconds > 0}>
          {form.retryAfterSeconds > 0 ? `${form.retryAfterSeconds} 秒后可重试` : '登录'}
        </Button>
      </form>
    </AuthCard>
  );
}
