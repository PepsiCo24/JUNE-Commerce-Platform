'use client';

import { loginSchema } from '@june/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

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

export function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh } = useAuth();
  const form = useAuthFormState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);

  const redirectTo = sanitizeRedirect(searchParams.get('redirect'));

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
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({
            schema: loginSchema,
            values: { email, password, remember },
            options: {
              messages: { INVALID_CREDENTIALS: '邮箱或密码不正确' },
              ignoreFieldErrorsFor: ['INVALID_CREDENTIALS'],
            },
            action: async (input) => {
              await api.post('/auth/login', input);
              await refresh();
              router.replace(redirectTo);
              router.refresh();
            },
          });
        }}
      >
        {form.formError ? <FormAlert>{form.formError}</FormAlert> : null}
        <Field label="邮箱" htmlFor="login-email" required error={form.fieldErrors.email}>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            invalid={Boolean(form.fieldErrors.email)}
            onChange={(event) => {
              setEmail(event.target.value);
              form.clearFieldError('email');
            }}
          />
        </Field>
        <Field label="密码" htmlFor="login-password" required error={form.fieldErrors.password}>
          <PasswordInput
            id="login-password"
            value={password}
            onChange={(value) => {
              setPassword(value);
              form.clearFieldError('password');
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
