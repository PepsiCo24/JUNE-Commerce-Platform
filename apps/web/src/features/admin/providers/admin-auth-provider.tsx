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
 *  - 探测到会话但 `!isAdmin` 时立即清会话并跳登录(防降权残留)。
 *
 * 权限判断的最终依据仍在后端;这里决定界面是否放行。
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

function isAdminUser(user: SessionUser | null | undefined): user is SessionUser {
  return Boolean(user?.isAdmin);
}

export function AdminAuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const redirectingRef = useRef(false);

  const fetchMe = useCallback(async (): Promise<SessionUser | null> => {
    try {
      const state = await adminApi.get<AuthStateResponse>(ADMIN_PATHS.auth.me, { silentUnauthorized: true });
      const next = isAdminUser(state.user) ? state.user : null;
      // 后端已拒绝非管理员;此处再挡一层,避免异常 payload 进入 UI
      if (state.user && !next) {
        try {
          await adminApi.post(ADMIN_PATHS.auth.logout);
        } catch {
          // ignore
        }
      }
      setUser(next);
      return next;
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
    if (isAdminUser(user)) return;
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    const current = `${window.location.pathname}${window.location.search}`;
    // 硬跳转:避免 App Router soft nav 与中间件 Cookie 判断不同步时卡在校验页
    window.location.replace(`${LOGIN_PATH}?redirect=${encodeURIComponent(current)}`);
  }, [isLoading, pathname, user]);

  // 登录页若带着无效/非管理员会话残留,清掉并留在登录表单
  useEffect(() => {
    if (isLoading) return;
    if (pathname !== LOGIN_PATH) return;
    if (user && !isAdminUser(user)) {
      setUser(null);
    }
  }, [isLoading, pathname, user]);

  const value = useMemo<AdminAuthContextValue>(
    () => ({
      user: isAdminUser(user) ? user : null,
      isLoading,
      isAuthenticated: isAdminUser(user),
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
