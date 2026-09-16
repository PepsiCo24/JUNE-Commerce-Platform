'use client';

import { THEME_PREFERENCES, type ThemePreference } from '@june/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from './auth-provider';

/** 匿名用户与账号隔离的本地主题键 */
const STORAGE_PREFIX = 'june.prefs.theme';

export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (value: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function storageKey(userId: string | null): string {
  return userId ? `${STORAGE_PREFIX}.${userId}` : STORAGE_PREFIX;
}

function readStored(userId: string | null): ThemePreference | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(storageKey(userId));
  if (raw && (THEME_PREFERENCES as readonly string[]).includes(raw)) {
    return raw as ThemePreference;
  }
  return null;
}

function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'light') return 'light';
  if (preference === 'dark') return 'dark';
  return systemDark ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [systemDark, setSystemDark] = useState(false);
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(query.matches);
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // 登录用户优先服务端偏好,否则读本地(按账号隔离)
  useEffect(() => {
    if (user?.theme) {
      setPreferenceState(user.theme);
      window.localStorage.setItem(storageKey(user.id), user.theme);
      return;
    }
    const stored = readStored(userId);
    setPreferenceState(stored ?? 'system');
  }, [user?.theme, user?.id, userId]);

  const resolved = resolveTheme(preference, systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setPreference = useCallback(
    (value: ThemePreference) => {
      setPreferenceState(value);
      window.localStorage.setItem(storageKey(userId), value);
    },
    [userId],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return context;
}
