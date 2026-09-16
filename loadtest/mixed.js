/**
 * 50 虚拟用户 × 30 分钟混合操作。
 *
 * 请求比例（按迭代内加权随机，记录在 README）:
 *   浏览帖子 40% / 帖子详情 15% / 评论 8% / 店铺列表 12% /
 *   商品列表 10% / 任务列表 8% / 生图提交 5% / 文案提交 2%
 * 操作间隔: think 0.5–3s（模拟真人）。
 * 压测位置: 默认打 BASE_URL（Nginx 入口）。直打 API 用 BASE_URL=http://127.0.0.1:3001
 *   并确保路径仍带 /api（本脚本已拼 /api）。
 *
 * 前置: LOADTEST_PASSWORD=... pnpm loadtest:seed
 * 生图走进程内 MOCK 适配器，不要对真实供应商做容量压测。
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { login, API, jsonHeaders, isUnexpected, idempotencyKey } from './lib.js';

const unexpected = new Rate('unexpected_errors');
const submitMs = new Trend('ai_submit_ms');

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 50),
      duration: __ENV.DURATION || '30m',
    },
  },
  thresholds: {
    unexpected_errors: ['rate<0.01'],
  },
};

function pick(csrf) {
  const roll = Math.random();
  if (roll < 0.4) return browsePosts();
  if (roll < 0.55) return postDetail();
  if (roll < 0.63) return comment(csrf);
  if (roll < 0.75) return shops();
  if (roll < 0.85) return products();
  if (roll < 0.93) return tasks();
  if (roll < 0.98) return submitImage(csrf);
  return submitCopy(csrf);
}

function browsePosts() {
  const res = http.get(`${API}/community/posts?sort=latest&limit=20`, { tags: { name: 'community.list' } });
  check(res, { 'posts list <400': (r) => r.status < 400 });
  unexpected.add(isUnexpected(res));
  return res;
}

function postDetail() {
  const list = http.get(`${API}/community/posts?sort=hot&limit=20`, { tags: { name: 'community.list' } });
  unexpected.add(isUnexpected(list));
  let slug = '';
  try {
    const items = list.json('items') || [];
    if (items.length) slug = items[Math.floor(Math.random() * items.length)].slug;
  } catch (err) {
    slug = '';
  }
  if (!slug) return list;
  const res = http.get(`${API}/community/posts/${encodeURIComponent(slug)}`, { tags: { name: 'community.detail' } });
  check(res, { 'post detail <500': (r) => r.status < 500 });
  unexpected.add(isUnexpected(res));
  return res;
}

function comment(csrf) {
  const list = http.get(`${API}/community/posts?sort=latest&limit=5`, { tags: { name: 'community.list' } });
  unexpected.add(isUnexpected(list));
  let postId = '';
  try {
    const items = list.json('items') || [];
    if (items.length) postId = items[0].id;
  } catch (err) {
    postId = '';
  }
  if (!postId) return list;
  const res = http.post(
    `${API}/community/posts/${postId}/comments`,
    JSON.stringify({ content: `压测评论 ${Date.now()}` }),
    { headers: jsonHeaders(csrf), tags: { name: 'community.comment' } },
  );
  check(res, { 'comment 2xx/4xx': (r) => r.status < 500 });
  unexpected.add(isUnexpected(res));
  return res;
}

function shops() {
  const res = http.get(`${API}/shops?page=1&pageSize=20&type=ALL&status=ALL`, { tags: { name: 'shops.list' } });
  unexpected.add(isUnexpected(res));
  return res;
}

function products() {
  const res = http.get(`${API}/products?limit=20`, { tags: { name: 'products.list' } });
  unexpected.add(isUnexpected(res));
  return res;
}

function tasks() {
  const res = http.get(`${API}/generation/tasks?type=ALL&status=ALL&limit=20`, { tags: { name: 'tasks.list' } });
  unexpected.add(isUnexpected(res));
  return res;
}

function submitImage(csrf) {
  const started = Date.now();
  const res = http.post(
    `${API}/generation/image`,
    JSON.stringify({
      prompt: '压测生图，结果必须带 MOCK 标识',
      count: 1,
      idempotencyKey: idempotencyKey(),
    }),
    { headers: jsonHeaders(csrf), tags: { name: 'generation.image' } },
  );
  submitMs.add(Date.now() - started);
  // 202 成功入队；4xx 可能是未配置 MOCK 模型 / 队列满，计入业务错误但不算平台 5xx
  check(res, { 'image submit not 5xx': (r) => r.status < 500 });
  unexpected.add(isUnexpected(res));
  return res;
}

function submitCopy(csrf) {
  const started = Date.now();
  const res = http.post(
    `${API}/generation/copy`,
    JSON.stringify({
      productName: '压测商品',
      sellingPoints: ['透气'],
      targetPlatform: 'taobao',
      style: 'concise',
      prompt: '写一句标题',
      titleCount: 1,
      idempotencyKey: idempotencyKey(),
    }),
    { headers: jsonHeaders(csrf), tags: { name: 'generation.copy' } },
  );
  submitMs.add(Date.now() - started);
  check(res, { 'copy submit not 5xx': (r) => r.status < 500 });
  unexpected.add(isUnexpected(res));
  return res;
}

let session;

export default function mixed() {
  if (!session || !session.ok) session = login();
  if (!session.ok) {
    unexpected.add(true);
    sleep(2);
    return;
  }
  pick(session.csrf);
  sleep(0.5 + Math.random() * 2.5);
}
