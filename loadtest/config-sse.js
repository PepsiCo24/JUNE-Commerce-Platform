/**
 * 配置热更新：登录后 GET /models/config 取 version，再以 200ms 间隔补拉，
 * 用于人工在后台改配置后观察「正常连接下目标 2 秒内」是否到达新版本。
 *
 * k6 不模拟浏览器 EventSource；本脚本验证补拉接口时延。SSE 本身请用浏览器双标签验收。
 *
 *   LOADTEST_PASSWORD=... k6 run loadtest/config-sse.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { login, API } from './lib.js';

const pollMs = new Trend('config_poll_ms');

export const options = {
  vus: 2,
  duration: __ENV.DURATION || '2m',
  thresholds: {
    config_poll_ms: ['p(95)<500'],
  },
};

let session;

export default function configPoll() {
  if (!session || !session.ok) session = login();
  if (!session.ok) return;

  const started = Date.now();
  const res = http.get(`${API}/models/config`, { tags: { name: 'models.config' } });
  pollMs.add(Date.now() - started);
  check(res, { 'config 200': (r) => r.status === 200 });
  sleep(0.2);
}
