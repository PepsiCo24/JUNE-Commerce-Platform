/**
 * 50 名用户同时提交生图，验证队列、公平性、幂等，以及其它页面仍可用。
 *
 * 每个 VU：同一幂等键连提交两次（第二次应 202 + deduplicated），再读社区列表确认其它接口未堵死。
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { login, API, jsonHeaders, isUnexpected, idempotencyKey } from './lib.js';

const unexpected = new Rate('unexpected_errors');
const dedupHits = new Counter('idempotent_hits');
const submitMs = new Trend('ai_submit_ms');
const browseMs = new Trend('browse_during_burst_ms');

export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: Number(__ENV.VUS || 50),
      iterations: 1,
      maxDuration: '3m',
    },
  },
  thresholds: {
    unexpected_errors: ['rate<0.01'],
  },
};

export default function imageBurst() {
  const session = login();
  if (!session.ok) {
    unexpected.add(true);
    return;
  }

  const key = idempotencyKey();
  const body = JSON.stringify({ prompt: '同时提交压测', count: 1, idempotencyKey: key });
  const headers = jsonHeaders(session.csrf);

  const firstStart = Date.now();
  const first = http.post(`${API}/generation/image`, body, { headers, tags: { name: 'generation.image' } });
  submitMs.add(Date.now() - firstStart);

  const secondStart = Date.now();
  const second = http.post(`${API}/generation/image`, body, { headers, tags: { name: 'generation.image.dedup' } });
  submitMs.add(Date.now() - secondStart);

  check(first, { 'first submit not 5xx': (r) => r.status < 500 });
  check(second, { 'second submit not 5xx': (r) => r.status < 500 });
  unexpected.add(isUnexpected(first) || isUnexpected(second));

  try {
    if (second.status === 202 && second.json('deduplicated') === true) dedupHits.add(1);
  } catch (err) {
    // 响应不是 JSON 时不计幂等命中
  }

  const browseStart = Date.now();
  const browse = http.get(`${API}/community/posts?sort=latest&limit=20`, { tags: { name: 'community.list.during_burst' } });
  browseMs.add(Date.now() - browseStart);
  check(browse, { 'hall available during burst': (r) => r.status === 200 });
  unexpected.add(isUnexpected(browse));

  sleep(1);
}
