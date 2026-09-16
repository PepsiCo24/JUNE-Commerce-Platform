'use client';

import { updateProfileSchema, type SessionUser } from '@june/shared';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { formatDateTime } from '@/lib/utils';
import { api } from '@/lib/api/client';
import { useAuth } from '@/providers/auth-provider';

import { FormAlert } from './form-alert';
import { useAuthFormState } from './form-state';

export function ProfileForm(): React.JSX.Element {
  const { user, patchUser, refresh } = useAuth();
  const form = useAuthFormState();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [location, setLocation] = useState(user?.location ?? '');
  const [website, setWebsite] = useState(user?.website ?? '');

  if (!user) return <p className="text-sm text-fg-muted">请先登录。</p>;

  return (
    <div className="space-y-6">
      <p className="text-sm text-fg-muted">
        <Link href={`/community/users/${user.id}`} className="text-accent hover:underline">
          查看公开主页
        </Link>
      </p>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({
            schema: updateProfileSchema,
            values: {
              displayName,
              bio: bio.trim() || null,
              location: location.trim() || null,
              website: website.trim() || null,
            },
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
          <Textarea id="profile-bio" value={bio} autoGrow onChange={(event) => setBio(event.target.value)} />
        </Field>
        <Field label="所在地" htmlFor="profile-location" error={form.fieldErrors.location}>
          <Input
            id="profile-location"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="可选"
          />
        </Field>
        <Field label="个人网站" htmlFor="profile-website" error={form.fieldErrors.website}>
          <Input
            id="profile-website"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            placeholder="https://"
            inputMode="url"
          />
        </Field>
        <Field label="邮箱" htmlFor="profile-email">
          <Input id="profile-email" value={user.email} disabled readOnly />
          <p className="mt-1 text-xs text-fg-subtle">邮箱仅本人可见。修改邮箱需配置邮件验证服务。</p>
        </Field>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-fg-subtle">用户 ID</dt>
            <dd className="font-mono text-xs text-fg-muted">{user.id}</dd>
          </div>
          <div>
            <dt className="text-fg-subtle">注册时间</dt>
            <dd className="text-fg-muted">{formatDateTime(user.createdAt)}</dd>
          </div>
        </dl>
        <Button type="submit" loading={form.submitting}>
          保存基本资料
        </Button>
      </form>
    </div>
  );
}
