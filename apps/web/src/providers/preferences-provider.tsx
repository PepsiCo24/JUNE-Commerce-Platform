'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * 用户界面偏好。
 *
 * 目前只有"减少动态效果"一项:
 *  - 默认跟随系统 prefers-reduced-motion;
 *  - 用户可在账号菜单里手动开启,覆盖系统设置并持久化;
 *  - 生效方式是往 <html> 写 data-reduced-motion,由 globals.css 里的规则统一降级动效,
 *    这样不需要每个组件各自判断。
 */

const STORAGE_KEY = 'june.prefs.reducedMotion';

interface PreferencesContextValue {
  /** 最终生效值(系统偏好 或 用户手动开启) */
  reducedMotion: boolean;
  /** 用户显式设置值;null 表示跟随系统 */
  reducedMotionOverride: boolean | null;
  systemReducedMotion: boolean;
  setReducedMotionOverride: (value: boolean | null) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function readStored(): boolean | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

export function PreferencesProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [override, setOverride] = useState<boolean | null>(null);

  // 初始读取:localStorage 只在客户端可用,放到 effect 里避免 hydration 不一致
  useEffect(() => {
    setOverride(readStored());
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setSystemReducedMotion(query.matches);

    const onChange = (event: MediaQueryListEvent): void => setSystemReducedMotion(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const reducedMotion = override ?? systemReducedMotion;

  useEffect(() => {
    document.documentElement.dataset.reducedMotion = reducedMotion ? 'true' : 'false';
  }, [reducedMotion]);

  const setReducedMotionOverride = useCallback((value: boolean | null) => {
    setOverride(value);
    if (value === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    }
  }, []);

  const value = useMemo<PreferencesContextValue>(
    () => ({ reducedMotion, reducedMotionOverride: override, systemReducedMotion, setReducedMotionOverride }),
    [reducedMotion, override, systemReducedMotion, setReducedMotionOverride],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('usePreferences 必须在 PreferencesProvider 内使用');
  return context;
}

/** 组件里需要跳过 Motion 动画时使用 */
export function useReducedMotion(): boolean {
  return usePreferences().reducedMotion;
}
