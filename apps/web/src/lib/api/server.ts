import { cookies, headers } from 'next/headers';

import { ApiError, NetworkError, toApiError } from './errors';

/**
 * 服务端(RSC / Server Action)API 调用。
 *
 * 与浏览器侧的区别:
 *  1. 直连容器内网的 API(INTERNAL_API_ORIGIN),不经过 Nginx,少一跳。
 *  2. 必须手动转发用户 Cookie,否则后端拿不到会话 —— 权限校验仍然完全在后端完成,
 *     前端"看不到入口"不等于"拿不到数据",两侧不可互相替代。
 *  3. 只做读取。写操作统一走浏览器侧客户端,以便正确携带 CSRF 与展示提交状态。
 */

const INTERNAL_API_ORIGIN = process.env.INTERNAL_API_ORIGIN ?? 'http://127.0.0.1:3001';

export interface ServerFetchOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  /** 秒。默认不缓存:业务数据与权限相关,过期缓存不得用于放行 */
  revalidate?: number;
  timeoutMs?: number;
}

function buildUrl(path: string, query?: ServerFetchOptions['query']): string {
  const url = new URL(path.startsWith('/') ? `/api${path}` : `/api/${path}`, INTERNAL_API_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * 服务端 GET。失败时抛 ApiError,由页面的 error.tsx / notFound() 处理。
 */
export async function serverGet<T>(path: string, options: ServerFetchOptions = {}): Promise<T> {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const requestHeaders: Record<string, string> = {
    Accept: 'application/json',
  };
  if (cookieHeader) requestHeaders.Cookie = cookieHeader;

  // 透传真实客户端信息,便于后端限流与审计记录到正确的来源
  const forwardedFor = headerStore.get('x-forwarded-for');
  if (forwardedFor) requestHeaders['x-forwarded-for'] = forwardedFor;
  const userAgent = headerStore.get('user-agent');
  if (userAgent) requestHeaders['user-agent'] = userAgent;
  const requestId = headerStore.get('x-request-id');
  if (requestId) requestHeaders['x-request-id'] = requestId;

  const timeoutMs = options.timeoutMs ?? 10_000;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: 'GET',
      headers: requestHeaders,
      signal: AbortSignal.timeout(timeoutMs),
      // 带 Cookie 的响应绝不能进共享缓存
      cache: options.revalidate === undefined ? 'no-store' : undefined,
      next: options.revalidate === undefined ? undefined : { revalidate: options.revalidate },
    });
  } catch (cause) {
    throw new NetworkError('无法连接到服务,请稍后重试', cause);
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw toApiError(response.status, payload, response.headers.get('x-request-id') ?? undefined);
  }

  return payload as T;
}

/**
 * 服务端 GET 的"宽容"版本:失败返回 null 而不抛错。
 * 用于"未登录也能渲染"的场景(如公开帖子详情页读取当前用户以决定是否显示编辑按钮)。
 */
export async function serverGetOptional<T>(path: string, options: ServerFetchOptions = {}): Promise<T | null> {
  try {
    return await serverGet<T>(path, options);
  } catch {
    return null;
  }
}

/**
 * 服务端 GET,失败时保留错误码(例如 POST_HIDDEN / POST_NOT_PUBLISHED)。
 * 公开帖子详情必须用这个而不是 serverGetOptional,否则会丢掉后端给出的可见性原因。
 */
export async function serverGetCaught<T>(
  path: string,
  options: ServerFetchOptions = {},
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError | NetworkError }> {
  try {
    return { ok: true, data: await serverGet<T>(path, options) };
  } catch (cause) {
    if (cause instanceof ApiError || cause instanceof NetworkError) {
      return { ok: false, error: cause };
    }
    return { ok: false, error: new NetworkError('无法连接到服务,请稍后重试', cause) };
  }
}
