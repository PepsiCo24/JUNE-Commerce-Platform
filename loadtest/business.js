/**
 * 普通业务负载：持续 20 请求/秒。
 *
 * 排除图片传输与模型耗时：只打列表/详情/统计/配置读取。
 * 目标：P95 < 800ms，非预期错误率（5xx）< 1%。
 *
 *   LOADTEST_PASSWORD=... k6 run loadtest/business.js
 */
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { login, API, isUnexpected } from './lib.js';

const unexpected = new Rate('unexpected_errors');

export const options = {
  scenarios: {
    business: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 20),
      timeUnit: '1s',
      duration: __ENV.DURATION || '10m',
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<800'],
    unexpected_errors: ['rate<0.01'],
  },
};

const ROUTES = [
  ['GET', '/community/posts?sort=latest&limit=20', 'community.list'],
  ['GET', '/community/posts?sort=hot&limit=20', 'community.hot'],
  ['GET', '/shops?page=1&pageSize=20&type=ALL&status=ALL', 'shops.list'],
  ['GET', '/shops/stats', 'shops.stats'],
  ['GET', '/products?limit=20', 'products.list'],
  ['GET', '/generation/tasks?type=ALL&status=ALL&limit=20', 'tasks.list'],
  ['GET', '/models/config', 'models.config'],
  ['GET', '/assets/usage', 'assets.usage'],
  ['GET', '/health/ready', 'health.ready'],
];

let session;

export default function business() {
  if (!session || !session.ok) session = login();
  if (!session.ok) {
    unexpected.add(true);
    return;
  }
  const route = ROUTES[Math.floor(Math.random() * ROUTES.length)];
  const res = http.get(`${API}${route[1]}`, { tags: { name: route[2] } });
  check(res, { [`${route[2]} ok`]: (r) => r.status < 400 });
  unexpected.add(isUnexpected(res));
}
