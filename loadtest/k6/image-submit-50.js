/**
 * 50 人同时提交生图。
 *
 * 每个 VU 登录一个独立压测账号,同时发出 1 次 MOCK 生图。
 * 测的是并发闸门 / 队列入队,不是 50 张图都生成完毕的墙钟时间。
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { api, authHeaders, login, pickMockImageModel, uuid } from './lib.js';

const accepted = new Counter('image_submit_accepted');
const rejected = new Counter('image_submit_rejected');

export const options = {
  scenarios: {
    burst: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: 50,
      maxDuration: '2m',
    },
  },
};

export function setup() {
  const session = login(1);
  const mock = pickMockImageModel(session);
  if (!mock) {
    throw new Error('没有 isMock 生图模型,拒绝并发打真实上游。见 loadtest/README.md');
  }
  console.log(`[image-50] MOCK 模型 ${mock.displayName} (${mock.id})`);
  return { mockModelId: mock.id };
}

export default function (data) {
  const session = login(__VU);
  const res = http.post(
    api('/api/generation/image'),
    JSON.stringify({
      modelConfigId: data.mockModelId,
      prompt: `[MOCK] concurrent-50 vu=${__VU}`,
      count: 1,
      size: '512x512',
      idempotencyKey: uuid(),
    }),
    {
      headers: { ...authHeaders(session), 'Content-Type': 'application/json' },
      tags: { name: 'image_submit_50' },
    },
  );
  const ok = res.status === 202 || res.status === 200 || res.status === 409;
  if (ok) accepted.add(1);
  else {
    rejected.add(1);
    console.warn(`[image-50] vu=${__VU} status=${res.status} body=${String(res.body).slice(0, 200)}`);
  }
  check(res, { 'accepted or idempotent': () => ok });
  sleep(1);
}
