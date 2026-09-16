/**
 * 混合场景:50 VU × 30 分钟。
 *
 * 请求比例(按迭代内加权,不是伪造达标):
 *   40% GET /api/community/posts     帖子大厅
 *   20% GET /api/community/posts/:slug  详情(种子 slug loadtest-post-00N)
 *   15% GET /api/shops               店铺列表
 *   10% GET /health                  存活
 *   10% POST /api/generation/image   MOCK 生图提交(快速 202)
 *    5% GET /api/auth/me
 *
 * 阈值只是观察目标,脚本不会把未跑过的结果写成「已达标」。
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { api, authHeaders, login, pickMockImageModel, uuid } from './lib.js';

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000'],
  },
};

const mockMissing = new Rate('mock_model_missing');

export function setup() {
  const session = login(1);
  const mock = pickMockImageModel(session);
  if (!mock) {
    console.warn('[mixed] 没有 isMock=true 的生图模型。10% 生图请求会记 mock_model_missing,不会假装成功。');
  }
  return { mockModelId: mock ? mock.id : null };
}

export default function (data) {
  const vu = __VU;
  const session = login(vu);
  const roll = Math.random();

  if (roll < 0.4) {
    const res = http.get(api('/api/community/posts?limit=20'), {
      headers: authHeaders(session),
      tags: { name: 'community_list' },
    });
    check(res, { 'posts list <400': (r) => r.status < 400 });
  } else if (roll < 0.6) {
    const n = String(((vu - 1) % 200) + 1).padStart(3, '0');
    const res = http.get(api(`/api/community/posts/loadtest-post-${n}`), {
      headers: authHeaders(session),
      tags: { name: 'community_detail' },
    });
    check(res, { 'post detail reachable': (r) => r.status === 200 || r.status === 404 });
  } else if (roll < 0.75) {
    const res = http.get(api('/api/shops?page=1&pageSize=20'), {
      headers: authHeaders(session),
      tags: { name: 'shops_list' },
    });
    check(res, { 'shops list <400': (r) => r.status < 400 });
  } else if (roll < 0.85) {
    const res = http.get(`${(__ENV.BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '')}/health`, {
      tags: { name: 'health' },
    });
    check(res, { 'health ok': (r) => r.status === 200 });
  } else if (roll < 0.95) {
    if (!data.mockModelId) {
      mockMissing.add(1);
    } else {
      const res = http.post(
        api('/api/generation/image'),
        JSON.stringify({
          modelConfigId: data.mockModelId,
          prompt: `[MOCK] loadtest mixed vu=${vu}`,
          count: 1,
          size: '512x512',
          idempotencyKey: uuid(),
        }),
        {
          headers: { ...authHeaders(session), 'Content-Type': 'application/json' },
          tags: { name: 'ai_submit' },
        },
      );
      check(res, { 'image submit 202/200': (r) => r.status === 202 || r.status === 200 || r.status === 409 });
    }
  } else {
    const res = http.get(api('/api/auth/me'), {
      headers: authHeaders(session),
      tags: { name: 'auth_me' },
    });
    check(res, { 'me 200': (r) => r.status === 200 });
  }

  sleep(1);
}
