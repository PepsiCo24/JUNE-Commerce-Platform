/**
 * AI 提交 P95。
 *
 * 测的是 POST /api/generation/image 的**提交延迟**(接口应快速返回 taskId),
 * 不是上游出图完成时间。供应商必须是 MOCK(isMock=true)。
 *
 * 若没有 MOCK 模型,脚本会 abort,而不是用真实上游或伪造成功。
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { api, authHeaders, login, pickMockImageModel, uuid } from './lib.js';

const submitMs = new Trend('ai_submit_ms', true);

export const options = {
  scenarios: {
    ai_submit: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 20,
      maxVUs: 40,
    },
  },
  thresholds: {
    ai_submit_ms: ['p(95)<1500'],
    http_req_failed: ['rate<0.1'],
  },
};

export function setup() {
  const session = login(1);
  const mock = pickMockImageModel(session);
  if (!mock) {
    throw new Error(
      '没有 isMock 生图模型。先 pnpm db:seed && pnpm loadtest:seed,并设置 PROVIDER_SECRET_ENCRYPTION_KEY / MOCK_PROVIDER_ENABLED。拒绝打真实上游。',
    );
  }
  console.log(`[ai-submit] 使用 MOCK 模型 ${mock.displayName} (${mock.id})`);
  return { mockModelId: mock.id };
}

export default function (data) {
  const session = login((__VU % 50) + 1);
  const started = Date.now();
  const res = http.post(
    api('/api/generation/image'),
    JSON.stringify({
      modelConfigId: data.mockModelId,
      prompt: '[MOCK] p95 submit',
      count: 1,
      size: '512x512',
      idempotencyKey: uuid(),
    }),
    {
      headers: { ...authHeaders(session), 'Content-Type': 'application/json' },
      tags: { name: 'ai_submit' },
    },
  );
  submitMs.add(Date.now() - started);
  check(res, {
    'submit accepted': (r) => r.status === 202 || r.status === 200 || r.status === 409,
  });
  sleep(0.1);
}
