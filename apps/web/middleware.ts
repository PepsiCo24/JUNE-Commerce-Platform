import { SESSION_COOKIE_ADMIN, SESSION_COOKIE_SITE } from '@june/shared';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * 边缘中间件 —— 只做**重定向体验优化**,不是安全边界。
 *
 * ⚠ 必读:
 *  1. 这里**只检查会话 Cookie 是否存在**,不解签、不查库、不校验有效性,
 *     也无法判断 Cookie 是否过期、是否被前移的 sessionEpoch 作废、账号是否被禁用。
 *  2. 因此伪造一个同名 Cookie 就能"骗过"这里 —— 但那只能骗到一次页面渲染,
 *     **拿不到任何数据**:真正的鉴权在后端每个接口里做(会话校验 + RolesGuard + 归属校验),
 *     `(admin)/layout.tsx` 还会拒绝「已登录的非管理员站点用户」直达 /admin。
 *  3. 它存在的唯一理由是:让未登录用户在请求页面之前就被弹回登录页,
 *     省掉一次 RSC 渲染与一次 /auth/me 往返,也避免登录页闪烁。
 *
 * 管理站与站点会话完全隔离:
 *  - 站点 Cookie(june_session)不能进入 /admin 控制台;
 *  - 管理站 Cookie(june_admin_session)不能调用站点写接口。
 */

/** 未登录也必须可访问的公开路径前缀:已发布帖子的公开链接与分享短链。 */
const PUBLIC_PREFIXES = ['/community/posts', '/p'] as const;

/** 已登录后不应再停留的页面 */
const GUEST_ONLY_PATHS = ['/login', '/register'] as const;

/** 管理站独立会话;登录页自身必须放行,否则无法登录 */
const ADMIN_LOGIN_PATH = '/admin/login';

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** 把原始路径(含查询串)编码进 redirect 参数,登录成功后回跳 */
function loginRedirect(request: NextRequest, loginPath: string): NextResponse {
  const target = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const url = new URL(loginPath, request.url);
  // 只带站内相对路径;登录页在使用前还会再做一次白名单校验(见 features/auth/redirect.ts)
  url.searchParams.set('redirect', target);
  return NextResponse.redirect(url, 302);
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // 存在性检查 —— 再次强调:有 Cookie ≠ 已登录,只是"值得让它进去试一下"
  const hasSiteCookie = request.cookies.has(SESSION_COOKIE_SITE);
  const hasAdminCookie = request.cookies.has(SESSION_COOKIE_ADMIN);

  // ---- 管理站:独立会话,与站点会话互不通用 ----
  if (isUnder(pathname, '/admin')) {
    if (pathname === ADMIN_LOGIN_PATH) return NextResponse.next();
    if (!hasAdminCookie) return loginRedirect(request, ADMIN_LOGIN_PATH);
    return NextResponse.next();
  }

  // ---- 公开内容:未登录也能看已发布的帖子,绝不拦截 ----
  for (const prefix of PUBLIC_PREFIXES) {
    if (isUnder(pathname, prefix)) return NextResponse.next();
  }

  // ---- 已登录用户不再需要登录/注册页 ----
  if (GUEST_ONLY_PATHS.some((path) => pathname === path)) {
    if (hasSiteCookie) return NextResponse.redirect(new URL('/', request.url), 302);
    return NextResponse.next();
  }

  // ---- 其余 (app) 下的路径都需要站点会话 ----
  if (!hasSiteCookie) return loginRedirect(request, '/login');

  return NextResponse.next();
}

export const config = {
  /**
   * 排除:
   *  - /api        后端接口(鉴权由后端完成,中间件插手只会多一次重定向)
   *  - /_next      构建产物与图片优化
   *  - /brand      品牌静态资产(favicon、manifest 等,不含用户数据)
   *  - 带扩展名的静态文件(robots.txt、*.svg、*.png ...)
   */
  matcher: ['/((?!api(?:/|$)|_next/|brand(?:/|$)|.*\\.[^/]*$).*)'],
};
