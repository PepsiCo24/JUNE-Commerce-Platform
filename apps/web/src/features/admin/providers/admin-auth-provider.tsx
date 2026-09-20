'use client';

import type { AuthStateResponse, SessionUser } from '@june/shared';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { adminApi } from '@/features/admin/api/client';
import { ADMIN_PATHS } from '@/features/admin/api/paths';

/**
 * 管理站独立会话。
 *
 * 与站点 `AuthProvider` 的区别:
 *  - 探测的是 `/admin/auth/me`,不是 `/auth/me`;
 *  - Cookie 是 `june_admin_session`,站点会话无法进入 /admin;
 *  - CSRF 使用独立 Cookie `june_admin_csrf`,写请求由 `adminApi` 从该 Cookie 回填。
 *    打开管理站时 `/admin/auth/me` 会刷新该 Cookie,无需额外登录即可自愈。
 *
 * 权限判断的最终依据仍在后端;这里只决定界面显示什么。
 */

interface AdminAuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  refresh: () => Promise<SessionUser | null>;
  logout: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

const LOGIN_PATH = '/admin/login';

export function AdminAuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const redirectingRef = useRef(false);

  const fetchMe = useCallback(async (): Promise<SessionUser | null> => {
    try {
      const state = await adminApi.get<AuthStateResponse>(ADMIN_PATHS.auth.me, { silentUnauthorized: true });
      setUser(state.user);
      return state.user;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchMe().finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchMe]);

  const logout = useCallback(async () => {
    try {
      await adminApi.post(ADMIN_PATHS.auth.logout);
    } finally {
      setUser(null);
      router.replace(LOGIN_PATH);
      router.refresh();
    }
  }, [router]);

  // 未登录访问非 login 页 → 跳独立登录,保留回跳地址
  useEffect(() => {
    if (isLoading) return;
    if (pathname === LOGIN_PATH) return;
    if (user) return;
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    const current = `${window.location.pathname}${window.location.search}`;
    // 硬跳转:避免 App Router soft nav 与中间件 Cookie 判断不同步时卡在校验页
    window.location.replace(`${LOGIN_PATH}?redirect=${encodeURIComponent(current)}`);
  }, [isLoading, pathname, user]);

  const value = useMemo<AdminAuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: Boolean(user),
      refresh: fetchMe,
      logout,
    }),
    [user, isLoading, fetchMe, logout],
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthContextValue {
  const context = useContext(AdminAuthContext);
  if (!context) throw new Error('useAdminAuth 必须在 AdminAuthProvider 内使用');
  return context;
}
