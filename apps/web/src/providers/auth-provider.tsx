'use client';

import type { AuthStateResponse, SessionUser } from '@june/shared';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api, setCsrfToken, setUnauthorizedHandler } from '@/lib/api/client';

/**
 * 认证状态。
 *
 * 重要原则:
 *  1. 这里的状态只用于"决定界面显示什么",一切权限判断的最终依据都在后端。
 *     隐藏一个按钮不等于禁止一个操作。
 *  2. 会话是 HttpOnly Cookie,前端读不到;登录态通过 /auth/me 探测。
 *  3. CSRF 令牌随 /auth/me 返回,存内存(不进 localStorage),刷新页面重新获取。
 *  4. 社区与工作台共用同一份账号与会话;/admin 使用独立会话,由 AdminAuthProvider 管理。
 */

interface AuthContextValue {
  user: SessionUser | null;
  /** 首次探测尚未完成 */
  isLoading: boolean;
  isAuthenticated: boolean;
  /** 重新拉取当前用户(改资料、改密码后调用) */
  refresh: () => Promise<SessionUser | null>;
  logout: (options?: { allDevices?: boolean }) => Promise<void>;
  /** 本地更新用户资料,避免整页重新拉取 */
  patchUser: (patch: Partial<SessionUser>) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** 登录页路径。会话失效时统一跳这里,并带上回跳地址。 */
const LOGIN_PATH = '/login';

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: ReactNode;
  /** 由服务端渲染时注入,避免首屏闪烁未登录状态 */
  initialUser?: SessionUser | null;
}): React.JSX.Element {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(initialUser);
  const [isLoading, setIsLoading] = useState(true);
  /** 防止多次并发跳转登录页 */
  const redirectingRef = useRef(false);

  const fetchMe = useCallback(async (): Promise<SessionUser | null> => {
    try {
      const state = await api.get<AuthStateResponse>('/auth/me', { silentUnauthorized: true });
      setCsrfToken(state.csrfToken);
      setUser(state.user);
      return state.user;
    } catch {
      // 未登录是正常状态,不当作错误上抛
      setCsrfToken(null);
      setUser(null);
      return null;
    }
  }, []);

  // 首次挂载探测登录态并取回 CSRF 令牌
  useEffect(() => {
    let cancelled = false;
    void fetchMe().finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchMe]);

  // 注册全局 401 处理:任何请求遇到会话失效都跳登录页并保留回跳地址
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setCsrfToken(null);

      if (redirectingRef.current) return;
      redirectingRef.current = true;

      const current = `${window.location.pathname}${window.location.search}`;
      // 管理站有独立登录入口,不要把管理员导到普通登录页
      const target = current.startsWith('/admin')
        ? `/admin/login?redirect=${encodeURIComponent(current)}`
        : current === LOGIN_PATH
          ? LOGIN_PATH
          : `${LOGIN_PATH}?redirect=${encodeURIComponent(current)}`;

      router.replace(target);
      // 允许后续再次触发(例如用户又停留很久)
      window.setTimeout(() => {
        redirectingRef.current = false;
      }, 1500);
    });

    return () => setUnauthorizedHandler(null);
  }, [router]);

  const logout = useCallback(
    async (options?: { allDevices?: boolean }) => {
      try {
        await api.post(options?.allDevices ? '/auth/logout-all' : '/auth/logout');
      } finally {
        // 即使请求失败也清本地状态,避免界面停留在"已登录"
        setUser(null);
        setCsrfToken(null);
        router.replace(LOGIN_PATH);
        router.refresh();
      }
    },
    [router],
  );

  const patchUser = useCallback((patch: Partial<SessionUser>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: Boolean(user),
      refresh: fetchMe,
      logout,
      patchUser,
    }),
    [user, isLoading, fetchMe, logout, patchUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}

/** 仅需要用户对象时的便捷 hook */
export function useCurrentUser(): SessionUser | null {
  return useAuth().user;
}
