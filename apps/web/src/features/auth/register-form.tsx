'use client';

import { registerSchema } from '@june/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { useAuth } from '@/providers/auth-provider';

import { AuthCard } from './auth-card';
import { FormAlert } from './form-alert';
import { useAuthFormState } from './form-state';
import { PasswordInput } from './password-input';
import { PasswordStrengthMeter } from './password-strength';
import { sanitizeRedirect } from './redirect';

export function RegisterForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh } = useAuth();
  const form = useAuthFormState();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const redirectTo = sanitizeRedirect(searchParams.get('redirect'));

  return (
    <AuthCard
      title="注册"
      description="注册后即可进入社区与工作台。"
      footer={
        <p>
          已有账号？{' '}
          <Link href={`/login?redirect=${encodeURIComponent(redirectTo)}`} className="text-accent hover:underline">
            登录
          </Link>
        </p>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({
            schema: registerSchema,
            values: { displayName, email, password },
            action: async (input) => {
              await api.post('/auth/register', input);
              await refresh();
              router.replace(redirectTo);
              router.refresh();
            },
          });
        }}
      >
        {form.formError ? <FormAlert>{form.formError}</FormAlert> : null}
        <Field label="昵称" htmlFor="reg-name" required error={form.fieldErrors.displayName}>
          <Input
            id="reg-name"
            value={displayName}
            autoComplete="nickname"
            onChange={(event) => {
              setDisplayName(event.target.value);
              form.clearFieldError('displayName');
            }}
          />
        </Field>
        <Field label="邮箱" htmlFor="reg-email" required error={form.fieldErrors.email}>
          <Input
            id="reg-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              form.clearFieldError('email');
            }}
          />
        </Field>
        <Field label="密码" htmlFor="reg-password" required error={form.fieldErrors.password}>
          <PasswordInput
            id="reg-password"
            value={password}
            autoComplete="new-password"
            onChange={(value) => {
              setPassword(value);
              form.clearFieldError('password');
            }}
          />
        </Field>
        <PasswordStrengthMeter password={password} />
        <Button type="submit" fullWidth loading={form.submitting} disabled={form.retryAfterSeconds > 0}>
          {form.retryAfterSeconds > 0 ? `${form.retryAfterSeconds} 秒后可重试` : '创建账号'}
        </Button>
      </form>
    </AuthCard>
  );
}
