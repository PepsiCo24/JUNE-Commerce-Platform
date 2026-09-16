'use client';

import { updateProfileSchema, type SessionUser } from '@june/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/layout/page-header';
import { api } from '@/lib/api/client';
import { useAuth } from '@/providers/auth-provider';

import { FormAlert } from './form-alert';
import { useAuthFormState } from './form-state';

export function ProfileForm(): React.JSX.Element {
  const { user, patchUser, refresh } = useAuth();
  const form = useAuthFormState();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');

  return (
    <div className="mx-auto max-w-xl space-y-6 px-4 py-8">
      <PageHeader title="个人资料" description="社区与工作台共用这份资料。" />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({
            schema: updateProfileSchema,
            values: { displayName, bio },
            action: async (input) => {
              const next = await api.patch<SessionUser>('/auth/profile', input);
              patchUser(next);
              await refresh();
              toast.success('资料已保存');
            },
          });
        }}
      >
        {form.formError ? <FormAlert>{form.formError}</FormAlert> : null}
        <Field label="昵称" htmlFor="profile-name" required error={form.fieldErrors.displayName}>
          <Input
            id="profile-name"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              form.clearFieldError('displayName');
            }}
          />
        </Field>
        <Field label="简介" htmlFor="profile-bio" error={form.fieldErrors.bio}>
          <Textarea
            id="profile-bio"
            value={bio}
            autoGrow
            onChange={(event) => setBio(event.target.value)}
          />
        </Field>
        <Button type="submit" loading={form.submitting}>
          保存
        </Button>
      </form>
    </div>
  );
}
