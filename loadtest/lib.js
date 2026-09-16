/**
 * k6 公共辅助。每个 VU 登录一名 @loadtest.invalid 用户并记住 CSRF。
 *
 * 压测账号由 `pnpm loadtest:seed` 写入，密码来自环境变量 LOADTEST_PASSWORD。
 */
import http from 'k6/http';
import { check } from 'k6';

export const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
export const API = `${BASE}/api`;
export const PASSWORD = __ENV.LOADTEST_PASSWORD || '';
export const CSRF_HEADER = 'x-june-csrf';

export function userEmail(vu = __VU) {
  const n = Number(__ENV.LOADTEST_USER_OFFSET || 0) + vu;
  return `u${String(n).padStart(4, '0')}@loadtest.invalid`;
}

export function jsonHeaders(csrf, extra) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (csrf) headers[CSRF_HEADER] = csrf;
  return extra ? Object.assign(headers, extra) : headers;
}

/** 登录并返回 csrfToken。Cookie 由 k6 VU cookie jar 自动保存。 */
export function login(vu = __VU) {
  if (!PASSWORD || PASSWORD.length < 10) {
    throw new Error('请设置 LOADTEST_PASSWORD（与 loadtest:seed 时相同，至少 10 位）');
  }
  const email = userEmail(vu);
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email, password: PASSWORD, remember: false }),
    { headers: jsonHeaders(), tags: { name: 'auth.login' } },
  );
  check(res, { 'login 200': (r) => r.status === 200 });
  const me = http.get(`${API}/auth/me`, { headers: { Accept: 'application/json' }, tags: { name: 'auth.me' } });
  check(me, { 'me 200': (r) => r.status === 200 });
  let csrf = '';
  try {
    csrf = me.json('csrfToken') || '';
  } catch (err) {
    csrf = '';
  }
  return { email, csrf, ok: res.status === 200 && me.status === 200 };
}

export function isUnexpected(res) {
  if (res.status >= 500) return true;
  if (res.status === 0) return true;
  return false;
}

export function idempotencyKey() {
  return `lt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
