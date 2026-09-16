import { CSRF_HEADER, REAUTH_HEADER } from '@june/shared';

import { ApiError, NetworkError, toApiError } from './errors';

/**
 * 浏览器侧 API 客户端。
 *
 * 设计约定:
 *  1. 会话完全依赖 HttpOnly Cookie,前端拿不到也不需要 token。
 *     因此所有请求都带 `credentials: 'same-origin'`。
 *  2. CSRF 采用双提交 Cookie:后端签发的令牌通过 /api/auth/me 返回,
 *     前端保存在内存(不写 localStorage,避免 XSS 持久化窃取)并回填到请求头。
 *  3. 生产环境下 web 与 api 由 Nginx 反代到同源 /api,因此默认 baseUrl 为空字符串。
 *  4. 绝不在此处附加任何供应商密钥——前端资源里不存在任何模型密钥。
 */

/** 同源前缀。开发环境由 next.config.ts 的 rewrites 代理到本地 API。 */
const API_PREFIX = '/api';

/** 内存中的 CSRF 令牌 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/** 会话失效时的统一回调,由 AuthProvider 注册,避免这里直接依赖路由 */
type UnauthorizedHandler = (error: ApiError) => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON 请求体。需要上传文件时用 rawBody 传 FormData/Blob */
  body?: unknown;
  rawBody?: BodyInit;
  query?: Record<string, string | number | boolean | null | undefined | Array<string | number>>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 超时毫秒。默认 20 秒;AI 提交等接口本身是快速返回的,不需要长超时 */
  timeoutMs?: number;
  /** 敏感操作的一次性重验令牌 */
  reauthToken?: string;
  /** 幂等键:AI 任务提交使用,重复提交返回同一任务 */
  idempotencyKey?: string;
  /** true 时 401 不触发全局跳转(如登录页自身的探测请求) */
  silentUnauthorized?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = path.startsWith('/') ? `${API_PREFIX}${path}` : `${API_PREFIX}/${path}`;
  if (!query) return base;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }

  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * 发起请求。
 * 返回 `T`;204 与空响应体返回 `undefined as T`。
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const url = buildUrl(path, options.query);

  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');

  if (options.body !== undefined && options.rawBody === undefined) {
    headers.set('Content-Type', 'application/json');
  }

  // 只有会改变状态的请求需要 CSRF 头
  if (MUTATING_METHODS.has(method) && csrfToken) {
    headers.set(CSRF_HEADER, csrfToken);
  }
  if (options.reauthToken) {
    headers.set(REAUTH_HEADER, options.reauthToken);
  }
  if (options.idempotencyKey) {
    headers.set('x-june-idempotency-key', options.idempotencyKey);
  }

  // 超时与外部取消信号合并
  const timeoutMs = options.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
  const signals = [controller.signal, options.signal].filter((s): s is AbortSignal => Boolean(s));
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal,
    });
  } catch (cause) {
    clearTimeout(timer);
    if (cause instanceof DOMException && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) {
      // 外部主动取消时原样抛出,交给调用方忽略
      if (options.signal?.aborted) throw cause;
      throw new NetworkError('请求超时,请重试', cause);
    }
    throw new NetworkError('网络连接失败', cause);
  } finally {
    clearTimeout(timer);
  }

  const requestId = response.headers.get('x-request-id') ?? undefined;

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    if (!response.ok) throw toApiError(response.status, undefined, requestId);
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const payload: unknown = isJson ? await response.json().catch(() => undefined) : await response.text();

  if (!response.ok) {
    const error = toApiError(response.status, payload, requestId);
    if (error.isAuthError && !options.silentUnauthorized) {
      csrfToken = null;
      onUnauthorized?.(error);
    }
    throw error;
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method'>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};

/**
 * 直传对象存储。
 * 用后端签发的短时 PUT 签名 URL,**不经过我们的 API**,因此不带 Cookie 也不带 CSRF。
 * 上传完成后必须调用 /assets/confirm,由后端核验实际内容、大小与归属。
 */
export async function uploadToSignedUrl(params: {
  url: string;
  file: File | Blob;
  contentType: string;
  headers?: Record<string, string>;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { url, file, contentType, headers, onProgress, signal } = params;

  // 需要真实上传进度,因此这里用 XHR 而不是 fetch(fetch 无上传进度事件)
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);
    for (const [key, value] of Object.entries(headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        // 只有 lengthComputable 时才是真实百分比,否则不编造进度
        if (event.lengthComputable) {
          onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
        }
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new NetworkError(`上传失败(HTTP ${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new NetworkError('上传失败,请检查网络')));
    xhr.addEventListener('timeout', () => reject(new NetworkError('上传超时')));
    xhr.addEventListener('abort', () => reject(new DOMException('已取消上传', 'AbortError')));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.timeout = 5 * 60 * 1000;
    xhr.send(file);
  });
}

/** 生成幂等键。同一次用户操作重复提交(双击、断网重试)复用同一个键。 */
export function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
