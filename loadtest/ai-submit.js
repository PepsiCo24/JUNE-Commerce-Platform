/**
 * AI 提交接口时延：目标 P95 < 1 秒（仅提交入队，不含上游出图）。
 *
 * 使用进程内 MOCK 模型。未配置 MOCK 时 4xx 会拉高失败率，应先 seed 并在后台启用 MOCK。
 */
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { login, API, jsonHeaders, isUnexpected, idempotencyKey } from './lib.js';

const unexpected = new Rate('unexpected_errors');
const submit = new Trend('ai_submit_ms');

export const options = {
  scenarios: {
    submit: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 5),
      timeUnit: '1s',
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  thresholds: {
    ai_submit_ms: ['p(95)<1000'],
    unexpected_errors: ['rate<0.01'],
  },
};

let session;

export default function aiSubmit() {
  if (!session || !session.ok) session = login();
  if (!session.ok) {
    unexpected.add(true);
    return;
  }
  const started = Date.now();
  const res = http.post(
    `${API}/generation/image`,
    JSON.stringify({
      prompt: '压测提交时延',
      count: 1,
      idempotencyKey: idempotencyKey(),
    }),
    { headers: jsonHeaders(session.csrf), tags: { name: 'generation.image' } },
  );
  submit.add(Date.now() - started);
  check(res, {
    'accepted or backpressure': (r) => r.status === 202 || r.status === 429 || r.status === 409 || r.status === 400,
  });
  unexpected.add(isUnexpected(res));
}
