import { NextResponse } from 'next/server';

/**
 * 站点登录的无 JS 回退入口。
 *
 * Cursor 内置预览 / 客户端 hydrate 失败时,表单会原生 GET 当前页(表现为点登录没反应)。
 * 本路由接受 POST,代理 Nest `/api/auth/login`,回写 Cookie 后 303 跳转。
 */

function apiOrigin(): string {
  return (
    process.env.INTERNAL_API_ORIGIN?.trim() ||
    process.env.DEV_API_ORIGIN?.trim() ||
    process.env.PUBLIC_API_ORIGIN?.trim() ||
    'http://127.0.0.1:3001'
  );
}

function redirectWithError(request: Request, code: string): NextResponse {
  const url = new URL('/login', request.url);
  url.searchParams.set('error', code);
  const redirect = new URL(request.url).searchParams.get('redirect');
  if (redirect) url.searchParams.set('redirect', redirect);
  return NextResponse.redirect(url, 303);
}

function sanitizeRedirect(value: string | null): string {
  if (!value) return '/';
  const raw = value.trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  const pathOnly = raw.split(/[?#]/)[0] ?? '';
  if (pathOnly === '/login' || pathOnly === '/register' || pathOnly === '/admin/login') return '/';
  if (pathOnly.startsWith('/admin')) return '/';
  return raw;
}

export async function POST(request: Request): Promise<NextResponse> {
  let email = '';
  let password = '';
  let remember = false;
  let redirectTo = '/';

  try {
    const form = await request.formData();
    email = String(form.get('email') ?? '').trim();
    password = String(form.get('password') ?? '');
    remember = form.get('remember') === 'on' || form.get('remember') === 'true';
    redirectTo = sanitizeRedirect(String(form.get('redirect') ?? '') || null);
  } catch {
    return redirectWithError(request, 'invalid');
  }

  if (!email || !password) {
    return redirectWithError(request, 'required');
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiOrigin()}/api/auth/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': request.headers.get('user-agent') ?? 'june-login-submit',
        'X-Forwarded-For': request.headers.get('x-forwarded-for') ?? '',
      },
      body: JSON.stringify({ email, password, remember }),
      cache: 'no-store',
    });
  } catch {
    return redirectWithError(request, 'network');
  }

  if (!upstream.ok) {
    let code = 'credentials';
    try {
      const payload = (await upstream.json()) as { error?: { code?: string } };
      if (payload.error?.code === 'RATE_LIMITED') code = 'rate_limited';
    } catch {
      // ignore
    }
    return redirectWithError(request, code);
  }

  const response = NextResponse.redirect(new URL(redirectTo, request.url), 303);
  const setCookies =
    typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : (() => {
          const single = upstream.headers.get('set-cookie');
          return single ? [single] : [];
        })();

  for (const cookie of setCookies) {
    response.headers.append('Set-Cookie', cookie);
  }

  return response;
}
