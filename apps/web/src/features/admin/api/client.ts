'use client';

import { CSRF_COOKIE, CSRF_HEADER } from '@june/shared';

import { api, type RequestOptions } from '@/lib/api/client';

/**
 * 管理站的写请求客户端。
 *
 * 为什么不直接用 `api.post`:
 *  `@/lib/api/client` 的 CSRF 令牌存在模块级变量里,由站点侧 `AuthProvider` 从
 *  `/auth/me` 写入。管理站用的是**独立会话**(june_admin_session),一个只有管理员
 *  身份、没有站点会话的账号在 `/auth/me` 上会拿到 `csrfToken: null`,从而把模块级
 *  令牌清空,导致管理站的写请求被 CsrfGuard 拒绝。
 *
 *  后端的 CSRF 是双提交 Cookie:请求头必须与 `june_csrf` Cookie 相等,而该 Cookie
 *  刻意不是 HttpOnly(见 session.service.ts 的注释),因此这里每次写请求都直接从
 *  Cookie 读取并显式回填请求头,不依赖任何共享的内存状态。
 *
 * 安全约束:这里不做任何凭据缓存。供应商 API Key / 微信 appSecret 等明文只会以
 * 请求体形式出现一次,既不写入 query cache,也不写入 localStorage。
 */

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function withCsrf(options?: Omit<RequestOptions, 'method' | 'body'>): Omit<RequestOptions, 'method' | 'body'> {
  const token = readCsrfCookie();
  if (!token) return options ?? {};
  return { ...options, headers: { [CSRF_HEADER]: token, ...options?.headers } };
}

export const adminApi = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) => api.get<T>(path, options),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api.post<T>(path, body, withCsrf(options)),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api.put<T>(path, body, withCsrf(options)),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api.patch<T>(path, body, withCsrf(options)),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method'>) => api.delete<T>(path, withCsrf(options)),
};
