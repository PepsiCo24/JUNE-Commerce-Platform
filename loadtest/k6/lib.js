/**
 * k6 共用:登录、CSRF、从 Cookie 读令牌。
 *
 * 压测账号由 `pnpm loadtest:seed` 写入,邮箱域 @loadtest.invalid。
 * 生图必须打到 MOCK 供应商(PublicModelOption.isMock === true)。
 *
 * 注意:部分 k6 executor 会在 iteration 之间清空 CookieJar。
 * 因此登录后把 june_session / june_csrf 写进请求头显式携带,不依赖 jar 跨轮次存活。
 */

import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
export const PASSWORD = __ENV.LOADTEST_PASSWORD || 'Loadtest-Passw0rd!';
export const EMAIL_DOMAIN = __ENV.LOADTEST_DOMAIN || 'loadtest.invalid';

export function api(path) {
  return `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export function userEmail(vu) {
  const n = String(vu).padStart(3, '0');
  return `loadtest-${n}@${EMAIL_DOMAIN}`;
}

function setCookieHeaderText(res) {
  const raw = res.headers['Set-Cookie'] || res.headers['set-cookie'] || '';
  return Array.isArray(raw) ? raw.join('\n') : String(raw);
}

function cookieValue(setCookieText, name) {
  const match = setCookieText.match(new RegExp(`${name}=([^;\\n]+)`));
  return match ? match[1] : '';
}

export function csrfFromResponse(res) {
  const fromHeader = cookieValue(setCookieHeaderText(res), 'june_csrf');
  if (fromHeader) return decodeURIComponent(fromHeader);
  const jarCookies = http.cookieJar().cookiesForURL(BASE_URL + '/');
  const fromJar = jarCookies['june_csrf'] && jarCookies['june_csrf'][0];
  return fromJar ? decodeURIComponent(fromJar) : '';
}

export function login(vu) {
  const email = userEmail(vu);
  const res = http.post(
    api('/api/auth/login'),
    JSON.stringify({ email, password: PASSWORD, remember: false }),
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, tags: { name: 'auth_login' } },
  );
  check(res, { 'login 200': (r) => r.status === 200 });
  const text = setCookieHeaderText(res);
  const sessionToken = cookieValue(text, 'june_session') || (http.cookieJar().cookiesForURL(BASE_URL + '/')['june_session'] || [])[0] || '';
  const csrf = csrfFromResponse(res);
  const cookie = [sessionToken ? `june_session=${sessionToken}` : '', csrf ? `june_csrf=${csrf}` : '']
    .filter(Boolean)
    .join('; ');
  return { email, csrf, cookie };
}

/** @param { { csrf?: string, cookie?: string } | string } sessionOrCsrf */
export function authHeaders(sessionOrCsrf, extra) {
  const headers = { Accept: 'application/json', ...(extra || {}) };
  if (typeof sessionOrCsrf === 'string') {
    if (sessionOrCsrf) headers['x-june-csrf'] = sessionOrCsrf;
    return headers;
  }
  if (sessionOrCsrf && sessionOrCsrf.csrf) headers['x-june-csrf'] = sessionOrCsrf.csrf;
  if (sessionOrCsrf && sessionOrCsrf.cookie) headers.Cookie = sessionOrCsrf.cookie;
  return headers;
}

export function pickMockImageModel(sessionOrCsrf) {
  const res = http.get(api('/api/models/config'), {
    headers: authHeaders(sessionOrCsrf),
    tags: { name: 'models_config' },
  });
  if (res.status !== 200) return null;
  const body = res.json();
  const models = (body && body.imageModels) || [];
  const mock = models.find((m) => m.isMock || String(m.providerSlug || '').includes('mock'));
  return mock || null;
}

export function uuid() {
  return `lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
