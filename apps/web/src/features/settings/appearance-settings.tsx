'use client';

import { updateProfileSchema, type SessionUser } from '@june/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ThemePreference } from '@june/shared';
import { Monitor, Moon, Sun } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';
import { useAuth } from '@/providers/auth-provider';
import { useTheme } from '@/providers/theme-provider';

export function AppearanceSettings(): React.JSX.Element {
  const { user, patchUser, refresh } = useAuth();
  const { preference, setPreference } = useTheme();
  const [saving, setSaving] = useState(false);

  const save = async (theme = preference): Promise<void> => {
    setSaving(true);
    try {
      const parsed = updateProfileSchema.safeParse({ theme });
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

  const onPickTheme = (theme: typeof preference): void => {
    setPreference(theme);
    if (user) void save(theme);
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-fg">主题</h2>
        <p className="text-sm text-fg-muted">选择日间、夜间或跟随系统。顶栏按钮可快速切换。</p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { value: 'light' as ThemePreference, label: '日间', icon: <Sun size={16} /> },
              { value: 'dark' as ThemePreference, label: '夜间', icon: <Moon size={16} /> },
              { value: 'system' as ThemePreference, label: '跟随系统', icon: <Monitor size={16} /> },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={preference === option.value}
              disabled={saving}
              onClick={() => onPickTheme(option.value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                preference === option.value
                  ? 'border-accent-border bg-accent-surface text-accent'
                  : 'border-border-default bg-surface text-fg-muted hover:bg-surface-hover hover:text-fg',
              )}
            >
              {option.icon}
              {option.label}
            </button>
          ))}
        </div>
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
