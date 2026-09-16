#!/usr/bin/env node
/**
 * JUNE 压测用 HTTP 模拟供应商。
 * 不连接外网，不代表任何真实模型。响应一律带 X-June-Mock: 1。
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const LATENCY_MIN = Number(process.env.MOCK_LATENCY_MS_MIN ?? 600);
const LATENCY_MAX = Number(process.env.MOCK_LATENCY_MS_MAX ?? 2500);
const ERROR_RATE = Number(process.env.MOCK_ERROR_RATE ?? 0.02);
const RATE_LIMIT_RATE = Number(process.env.MOCK_RATE_LIMIT_RATE ?? 0.01);
const ASYNC_ROUNDS = Math.max(1, Number(process.env.MOCK_ASYNC_POLL_ROUNDS ?? 3));

/** 1×1 灰度 PNG，再叠加 MOCK 标识字段；浏览器可解码。 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createMockPng(width = 64, height = 64) {
  const raster = Buffer.alloc(width * height, 0x2a);
  for (let x = 0; x < width; x += 1) {
    raster[x] = 0xf0;
    raster[(height - 1) * width + x] = 0xf0;
  }
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    raster.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = createMockPng();
const PNG_B64 = PNG.toString('base64');

/** @type {Map<string, { remaining: number; createdAt: number }>} */
const asyncTasks = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function latency() {
  return LATENCY_MIN + Math.random() * Math.max(0, LATENCY_MAX - LATENCY_MIN);
}

function send(res, status, body, extraHeaders = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-june-mock': '1',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function maybeFault(res) {
  const roll = Math.random();
  if (roll < RATE_LIMIT_RATE) {
    send(res, 429, { error: { message: '[MOCK] rate limited', type: 'rate_limit' } }, { 'retry-after': '2' });
    return true;
  }
  if (roll < RATE_LIMIT_RATE + ERROR_RATE) {
    send(res, 503, { error: { message: '[MOCK] injected upstream error', type: 'upstream_error' } });
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    send(res, 200, { status: 'ok', mock: true });
    return;
  }

  await sleep(latency());
  if (maybeFault(res)) return;

  if (req.method === 'POST' && (url.pathname === '/v1/images/generations' || url.pathname === '/v1/images/edits')) {
    const body = await readBody(req);
    const n = Math.min(4, Math.max(1, Number(body.n ?? 1)));
    send(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: Array.from({ length: n }, () => ({ b64_json: PNG_B64, revised_prompt: '[MOCK]' })),
      model: 'mock-http-sync',
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/tasks') {
    const id = randomUUID();
    asyncTasks.set(id, { remaining: ASYNC_ROUNDS, createdAt: Date.now() });
    send(res, 202, { id, status: 'queued', model: 'mock-http-async' });
    return;
  }

  const taskMatch = url.pathname.match(/^\/v1\/tasks\/([A-Za-z0-9-]+)$/);
  if (req.method === 'GET' && taskMatch) {
    const id = taskMatch[1];
    const task = asyncTasks.get(id);
    if (!task) {
      send(res, 404, { error: { message: '[MOCK] task not found' } });
      return;
    }
    task.remaining -= 1;
    if (task.remaining > 0) {
      send(res, 200, { id, status: 'running', model: 'mock-http-async' });
      return;
    }
    asyncTasks.delete(id);
    send(res, 200, {
      id,
      status: 'succeeded',
      model: 'mock-http-async',
      data: [{ b64_json: PNG_B64 }],
    });
    return;
  }

  send(res, 404, { error: { message: '[MOCK] unknown route', path: url.pathname } });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`[MOCK] provider listening on ${PORT}\n`);
});
