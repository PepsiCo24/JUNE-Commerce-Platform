'use client';

import { updateProfileSchema, type SessionUser } from '@june/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { ThemePreferencePicker } from '@/components/system/theme-toggle';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';
import { useAuth } from '@/providers/auth-provider';
import { useTheme } from '@/providers/theme-provider';

export function AppearanceSettings(): React.JSX.Element {
  const { user, patchUser, refresh } = useAuth();
  const { preference, setPreference } = useTheme();
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const parsed = updateProfileSchema.safeParse({ theme: preference });
      if (!parsed.success) {
        toast.error('主题设置无效');
        return;
      }
      const next = await api.patch<SessionUser>('/auth/profile', parsed.data);
      patchUser(next);
      await refresh();
      toast.success('外观设置已保存');
    } catch {
      toast.error('保存失败,请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-fg">主题</h2>
        <p className="text-sm text-fg-muted">选择日间、夜间或跟随系统。顶栏按钮可快速切换。</p>
        <ThemePreferencePicker />
        {user ? (
          <p className="text-xs text-fg-subtle">当前账号:{user.email}</p>
        ) : null}
      </section>
      <Button loading={saving} onClick={() => void save()}>
        保存外观设置
      </Button>
    </div>
  );
}
