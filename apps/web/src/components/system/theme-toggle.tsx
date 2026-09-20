'use client';

import type { SessionUser, ThemePreference } from '@june/shared';
import { Monitor, Moon, Sun } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api } from '@/lib/api/client';
import { useAuth } from '@/providers/auth-provider';
import { useTheme } from '@/providers/theme-provider';

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  { value: 'light', label: '日间', icon: <Sun size={16} /> },
  { value: 'dark', label: '夜间', icon: <Moon size={16} /> },
  { value: 'system', label: '跟随系统', icon: <Monitor size={16} /> },
];

async function persistTheme(user: SessionUser | null, theme: ThemePreference, patchUser: (u: SessionUser) => void): Promise<void> {
  if (!user) return;
  try {
    const next = await api.patch<SessionUser>('/auth/profile', { theme });
    patchUser(next);
  } catch {
    toast.error('主题保存失败');
  }
}

/** 顶栏快捷切换:在 light / dark / system 间循环,登录用户立即持久化 */
export function ThemeToggle({ className }: { className?: string }): React.JSX.Element {
  const { user, patchUser } = useAuth();
  const { preference, resolved, setPreference } = useTheme();

  const cycle = (): void => {
    const next: ThemePreference = preference === 'light' ? 'dark' : preference === 'dark' ? 'system' : 'light';
    setPreference(next);
    void persistTheme(user, next, patchUser);
  };

  const icon = resolved === 'dark' ? <Moon size={18} /> : <Sun size={18} />;
  const title =
    preference === 'system'
      ? `跟随系统(当前${resolved === 'dark' ? '夜间' : '日间'})`
      : preference === 'dark'
        ? '夜间模式'
        : '日间模式';

  return (
    <button
      type="button"
      aria-label={title}
      title={`${title} · 点击切换`}
      onClick={cycle}
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-md text-fg-muted transition-colors',
        'hover:bg-surface-hover hover:text-fg',
        className,
      )}
    >
      {icon}
    </button>
  );
}

export function ThemePreferencePicker(): React.JSX.Element {
  const { user, patchUser } = useAuth();
  const { preference, setPreference } = useTheme();

  return (
    <div className="flex flex-wrap gap-2">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={preference === option.value}
          onClick={() => {
            setPreference(option.value);
            void persistTheme(user, option.value, patchUser);
          }}
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
  );
}
