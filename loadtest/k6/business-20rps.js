/**
 * 普通业务恒定 20 rps。
 *
 * 比例:
 *   50% 帖子大厅
 *   25% 帖子详情
 *   15% 店铺列表
 *   10% 存活探针
 *
 * 不含生图。阈值是观察目标,不是已测达标声明。
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { api, authHeaders, login } from './lib.js';

export const options = {
  scenarios: {
    business: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 30,
      maxVUs: 60,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<800'],
  },
};

export function setup() {
  // 只做连通性检查;真正的会话在每个 VU 内登录一次并复用
  const probe = login(1);
  if (!probe.csrf) {
    throw new Error('setup 登录失败:无法拿到 CSRF,请确认压测账号与 API 可用');
  }
  return { ok: true };
}

/** 每个 VU 进程内复用自己的会话,避免每轮打登录把 AUTH 限流打满 */
const vuSession = {};

export default function () {
  const vu = (__VU % 20) + 1;
  if (!vuSession.current) {
    vuSession.current = login(vu);
  }
  const session = vuSession.current;
  const roll = Math.random();

  if (roll < 0.5) {
    const res = http.get(api('/api/community/posts?limit=20'), {
      headers: authHeaders(session),
      tags: { name: 'community_list' },
    });
    check(res, { 'list ok': (r) => r.status === 200 });
  } else if (roll < 0.75) {
    const n = String((Math.floor(Math.random() * 50) + 1)).padStart(3, '0');
    const res = http.get(api(`/api/community/posts/loadtest-post-${n}`), {
      headers: authHeaders(session),
      tags: { name: 'community_detail' },
    });
    check(res, { 'detail reachable': (r) => r.status === 200 || r.status === 404 });
  } else if (roll < 0.9) {
    const res = http.get(api('/api/shops?page=1&pageSize=20'), {
      headers: authHeaders(session),
      tags: { name: 'shops_list' },
    });
    check(res, { 'shops ok': (r) => r.status === 200 });
  } else {
    const res = http.get(`${(__ENV.BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '')}/health`, {
      tags: { name: 'health' },
    });
    check(res, { 'health ok': (r) => r.status === 200 });
  }

  sleep(0.05);
}
