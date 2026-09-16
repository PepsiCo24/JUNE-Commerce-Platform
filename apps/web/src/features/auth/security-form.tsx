'use client';

import { changePasswordSchema } from '@june/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/input';
import { PageHeader } from '@/components/layout/page-header';
import { api } from '@/lib/api/client';

import { FormAlert } from './form-alert';
import { useAuthFormState } from './form-state';
import { PasswordInput } from './password-input';
import { PasswordStrengthMeter } from './password-strength';

export function SecurityForm(): React.JSX.Element {
  const router = useRouter();
  const form = useAuthFormState();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  return (
    <div className="mx-auto max-w-xl space-y-6 px-4 py-8">
      <PageHeader title="安全" description="修改密码后，所有设备上的会话都会立即失效，需要重新登录。" />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({
            schema: changePasswordSchema,
            values: { currentPassword, newPassword },
            action: async (input) => {
              await api.post('/auth/change-password', input);
              toast.success('密码已更新，请重新登录');
              router.replace('/login');
              router.refresh();
            },
          });
        }}
      >
        {form.formError ? <FormAlert>{form.formError}</FormAlert> : null}
        <Field label="当前密码" htmlFor="cur-password" required error={form.fieldErrors.currentPassword}>
          <PasswordInput
            id="cur-password"
            value={currentPassword}
            autoComplete="current-password"
            onChange={(value) => {
              setCurrentPassword(value);
              form.clearFieldError('currentPassword');
            }}
          />
        </Field>
        <Field label="新密码" htmlFor="new-password" required error={form.fieldErrors.newPassword}>
          <PasswordInput
            id="new-password"
            value={newPassword}
            autoComplete="new-password"
            onChange={(value) => {
              setNewPassword(value);
              form.clearFieldError('newPassword');
            }}
          />
        </Field>
        <PasswordStrengthMeter password={newPassword} />
        <Button type="submit" loading={form.submitting}>
          更新密码
        </Button>
      </form>
    </div>
  );
}
