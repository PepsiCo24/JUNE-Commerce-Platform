/**
 * 管理站登录回跳白名单。规则与站点 `features/auth/redirect.ts` 相同,
 * 但回退地址是 `/admin`(管理站首页),而不是站点首页。
 */

const FALLBACK = '/admin';
const DISALLOWED = ['/login', '/register', '/admin/login'];

export function sanitizeAdminRedirect(value: string | null | undefined): string {
  if (!value) return FALLBACK;

  const raw = value.trim();
  if (raw.length === 0 || raw.length > 512) return FALLBACK;
  if (!raw.startsWith('/')) return FALLBACK;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return FALLBACK;
  // eslint-disable-next-line no-control-regex -- 拦截控制字符,防止开放重定向拼接注入
  if (/[\u0000-\u001F\u007F]/.test(raw)) return FALLBACK;

  const pathOnly = raw.split(/[?#]/)[0] ?? '';
  if (DISALLOWED.includes(pathOnly)) return FALLBACK;
  if (!pathOnly.startsWith('/admin')) return FALLBACK;

  return raw;
}
