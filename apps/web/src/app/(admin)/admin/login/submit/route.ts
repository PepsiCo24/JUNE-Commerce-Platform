import { NextResponse } from 'next/server';

/**
 * 管理站登录的无 JS 回退入口。
 *
 * 浏览器在客户端 hydrate 失败时会原生提交表单;若仍走 GET 当前页,表现为「点登录没反应」。
 * 本路由接受 POST 表单,代理到 Nest `/api/admin/auth/login`,回写 Cookie 后 303 跳控制台。
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
  const url = new URL('/admin/login', request.url);
  url.searchParams.set('error', code);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request): Promise<NextResponse> {
  let email = '';
  let password = '';
  try {
    const form = await request.formData();
    email = String(form.get('email') ?? '').trim();
    password = String(form.get('password') ?? '');
  } catch {
    return redirectWithError(request, 'invalid');
  }

  if (!email || !password) {
    return redirectWithError(request, 'required');
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiOrigin()}/api/admin/auth/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // 透传客户端 UA / IP 便于审计
        'User-Agent': request.headers.get('user-agent') ?? 'june-admin-login-submit',
        'X-Forwarded-For': request.headers.get('x-forwarded-for') ?? '',
      },
      body: JSON.stringify({ email, password }),
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
      else if (payload.error?.code === 'INVALID_CREDENTIALS') code = 'credentials';
    } catch {
      // ignore
    }
    return redirectWithError(request, code);
  }

  const redirectTo = new URL('/admin', request.url);
  const response = NextResponse.redirect(redirectTo, 303);

  // Node fetch 提供 getSetCookie;把上游会话 Cookie 原样交给浏览器
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
