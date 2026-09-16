/**
 * 失败分类与脱敏测试。
 *
 * 这是整个包最关键的一组测试:分类错了会导致
 *  - 该重试的不重试(用户白等),或
 *  - 不该重试的重试(重复计费)。
 */

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@june/shared';

import {
  classifyHttpFailure,
  classifyTransportFailure,
  parseRetryAfterSeconds,
  unknownResult,
  type HttpResponse,
} from './http';
import { formatUpstreamMessage, sanitizeUpstreamMessage } from './sanitize';
import {
  createMockImageProvider,
  getImageProvider,
  getTextProvider,
  ProviderNotImplementedError,
  UnknownProviderError,
} from './registry';
import type { ImageGenerationRequest, ProviderCredentials } from './types';

function response(status: number, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, bodyText: '', json: undefined };
}

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

describe('Retry-After 解析', () => {
  it('支持 delta-seconds 形式', () => {
    expect(parseRetryAfterSeconds('120')).toBe(120);
    expect(parseRetryAfterSeconds(' 30 ')).toBe(30);
    expect(parseRetryAfterSeconds('0')).toBe(0);
  });

  it('支持 HTTP-date 形式,换算成剩余秒数', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:29:00 GMT', now)).toBe(60);
    // 已经过去的时间点归零而不是负数
    expect(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:27:00 GMT', now)).toBe(0);
  });

  it('缺失或不可解析时返回 undefined,交给上层默认退避', () => {
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
    expect(parseRetryAfterSeconds('')).toBeUndefined();
    expect(parseRetryAfterSeconds('soon')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 429
// ---------------------------------------------------------------------------

describe('429 限流分类', () => {
  it('映射为 UPSTREAM_RATE_LIMITED、可重试,并带出 Retry-After', () => {
    const failure = classifyHttpFailure({
      phase: 'submit',
      providerLabel: 'X',
      response: response(429, { 'retry-after': '45' }),
      upstreamDetail: 'rate limit exceeded',
    });
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_RATE_LIMITED);
    expect(failure.retryable).toBe(true);
    expect(failure.retryAfterSeconds).toBe(45);
    expect(failure.httpStatus).toBe(429);
  });

  it('没有 Retry-After 时仍然可重试,只是不给建议间隔', () => {
    const failure = classifyHttpFailure({
      phase: 'submit',
      providerLabel: 'BFL FLUX',
      response: response(429),
      upstreamDetail: '超过 24 个活跃任务',
    });
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_RATE_LIMITED);
    expect(failure.retryable).toBe(true);
    expect(failure.retryAfterSeconds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 结果未知
// ---------------------------------------------------------------------------

describe('「结果未知」判定', () => {
  it('提交阶段超时 → UPSTREAM_RESULT_UNKNOWN 且不可重试', () => {
    const failure = classifyTransportFailure('submit', 'X', {
      cause: 'timeout',
      detail: 'TimeoutError: headers timeout',
    });
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN);
    expect(failure.retryable).toBe(false);
  });

  it('提交阶段连接中断 → 同样是结果未知', () => {
    const failure = classifyTransportFailure('submit', 'X', {
      cause: 'network',
      detail: 'SocketError: other side closed',
    });
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN);
    expect(failure.retryable).toBe(false);
  });

  it('提交阶段被取消(可能已到达上游)→ 结果未知', () => {
    const failure = classifyTransportFailure('submit', 'X', { cause: 'aborted', detail: 'AbortError' });
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN);
    expect(failure.retryable).toBe(false);
  });

  it('轮询阶段超时是只读查询 → UPSTREAM_TIMEOUT 且可重试', () => {
    const failure = classifyTransportFailure('poll', 'X', { cause: 'timeout', detail: 'TimeoutError' }, 'task-9');
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_TIMEOUT);
    expect(failure.retryable).toBe(true);
    expect(failure.providerTaskId).toBe('task-9');
  });

  it('提交阶段 5xx 且上游没给结构化错误体 → 结果未知', () => {
    for (const status of [500, 502, 503, 504]) {
      const failure = classifyHttpFailure({
        phase: 'submit',
        providerLabel: 'X',
        response: response(status),
        upstreamDetail: '<html>Bad Gateway</html>',
        hasStructuredError: false,
      });
      expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN);
      expect(failure.retryable).toBe(false);
    }
  });

  it('提交阶段 5xx 但上游给了结构化错误体 → 明确失败,可重试', () => {
    const failure = classifyHttpFailure({
      phase: 'submit',
      providerLabel: 'X',
      response: response(500),
      upstreamDetail: 'InternalError / 服务暂时异常',
      hasStructuredError: true,
    });
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_ERROR);
    expect(failure.retryable).toBe(true);
  });

  it('轮询阶段 5xx 一律可重试', () => {
    const failure = classifyHttpFailure({
      phase: 'poll',
      providerLabel: 'X',
      response: response(503),
      upstreamDetail: 'unavailable',
      providerTaskId: 'task-1',
    });
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_ERROR);
    expect(failure.retryable).toBe(true);
  });

  it('unknownResult 构造出的失败永远不可重试,并保留 providerTaskId', () => {
    const failure = unknownResult('X', '任务号 abc 状态无法确认', 'abc');
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN);
    expect(failure.retryable).toBe(false);
    expect(failure.providerTaskId).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// 4xx
// ---------------------------------------------------------------------------

describe('4xx 分类', () => {
  it('401 / 402 / 403 / 400 / 422 均不可重试', () => {
    for (const status of [400, 401, 402, 403, 404, 422]) {
      const failure = classifyHttpFailure({
        phase: 'submit',
        providerLabel: 'X',
        response: response(status),
        upstreamDetail: 'bad request',
      });
      expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_ERROR);
      expect(failure.retryable).toBe(false);
    }
  });

  it('408 是上游自报超时,可重试', () => {
    const failure = classifyHttpFailure({
      phase: 'submit',
      providerLabel: 'X',
      response: response(408),
      upstreamDetail: 'request timeout',
    });
    expect(failure.errorCode).toBe(ERROR_CODES.UPSTREAM_TIMEOUT);
    expect(failure.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

describe('sanitizeUpstreamMessage 脱敏', () => {
  it('抹掉 OpenAI / DashScope 形态的 key', () => {
    const out = sanitizeUpstreamMessage('Incorrect API key provided: sk-proj-AbCdEf1234567890xyz');
    expect(out).not.toContain('sk-proj-AbCdEf1234567890xyz');
    expect(out).toContain('[已脱敏]');
  });

  it('抹掉 Google AIza 形态的 key', () => {
    const out = sanitizeUpstreamMessage('API key not valid: AIzaSyD-1234567890abcdefg');
    expect(out).not.toContain('AIzaSyD-1234567890abcdefg');
  });

  it('抹掉 Authorization / x-key 请求头回显', () => {
    const out = sanitizeUpstreamMessage('{"headers":{"authorization":"Bearer sk-live-verysecret","x-key":"abc123def456"}}');
    expect(out).not.toContain('sk-live-verysecret');
    expect(out).not.toContain('abc123def456');
  });

  it('抹掉 data URI 里的参考图 base64', () => {
    const payload = `{"image":"data:image/png;base64,${'A'.repeat(500)}"}`;
    const out = sanitizeUpstreamMessage(payload);
    expect(out).not.toContain('A'.repeat(100));
    expect(out).toContain('base64 [已脱敏]');
  });

  it('抹掉不带前缀的裸 base64 长块', () => {
    const out = sanitizeUpstreamMessage(`{"input_image":"${'B'.repeat(400)}"}`);
    expect(out).not.toContain('B'.repeat(100));
  });

  it('抹掉签名链接的 query,但保留 host + path 便于排查', () => {
    const out = sanitizeUpstreamMessage(
      'failed to fetch https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.png?Expires=123&Signature=SECRETSIG',
    );
    expect(out).not.toContain('SECRETSIG');
    expect(out).toContain('dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.png');
  });

  it('抹掉 JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(sanitizeUpstreamMessage(`token=${jwt}`)).not.toContain(jwt);
  });

  it('超长文案被截断,不把整个请求体写进日志', () => {
    const out = sanitizeUpstreamMessage('错'.repeat(2000), 100);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain('已截断');
  });

  it('空输入给出可读兜底,而不是空字符串', () => {
    expect(sanitizeUpstreamMessage(undefined)).toBe('上游未返回可读的错误信息');
    expect(sanitizeUpstreamMessage('')).toBe('上游未返回可读的错误信息');
  });

  it('formatUpstreamMessage 保留供应商与状态码,同时脱敏上游文案', () => {
    const out = formatUpstreamMessage('OpenAI', 401, 'Invalid key sk-abcdefgh12345678');
    expect(out).toContain('[OpenAI HTTP 401]');
    expect(out).not.toContain('sk-abcdefgh12345678');
  });

  it('分类出的 message 一定是脱敏后的', () => {
    const failure = classifyHttpFailure({
      phase: 'submit',
      providerLabel: 'OpenAI',
      response: response(401),
      upstreamDetail: 'invalid_api_key / Incorrect API key provided: sk-secret-0123456789',
    });
    expect(failure.message).not.toContain('sk-secret-0123456789');
  });
});

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

describe('注册表', () => {
  it('5 家生图供应商 + MOCK 都有实现,kind 自洽', () => {
    for (const kind of ['OPENAI', 'GEMINI', 'ARK_SEEDREAM', 'ALIYUN_WANX', 'BFL_FLUX', 'MOCK'] as const) {
      const provider = getImageProvider(kind);
      expect(provider.kind).toBe(kind);
      expect(provider.describeDefaultModels().length).toBeGreaterThan(0);
    }
  });

  it('异步供应商必须实现 poll,同步供应商不需要', () => {
    expect(typeof getImageProvider('ALIYUN_WANX').poll).toBe('function');
    expect(typeof getImageProvider('BFL_FLUX').poll).toBe('function');
    expect(getImageProvider('OPENAI').poll).toBeUndefined();
    expect(getImageProvider('GEMINI').poll).toBeUndefined();
    expect(getImageProvider('ARK_SEEDREAM').poll).toBeUndefined();
  });

  it('未实现的组合抛带错误码的异常,不静默降级', () => {
    expect(() => getImageProvider('OPENAI_COMPATIBLE')).toThrow(ProviderNotImplementedError);
    expect(() => getTextProvider('BFL_FLUX')).toThrow(ProviderNotImplementedError);
    expect(() => getTextProvider('ALIYUN_WANX')).toThrow(ProviderNotImplementedError);

    try {
      getTextProvider('MOCK');
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotImplementedError);
      expect((err as ProviderNotImplementedError).code).toBe(ERROR_CODES.MODEL_CAPABILITY_MISMATCH);
    }
  });

  it('未知 kind 抛 UnknownProviderError', () => {
    // 模拟数据库里存了一个已下线的 providerSlug
    expect(() => getImageProvider('LEGACY_PROVIDER' as never)).toThrow(UnknownProviderError);
  });

  it('模拟供应商的 displayName 必须带 [MOCK] 前缀,且 verified 为 false', () => {
    for (const model of getImageProvider('MOCK').describeDefaultModels()) {
      expect(model.displayName.startsWith('[MOCK]')).toBe(true);
      expect(model.limits.verified).toBe(false);
      expect(model.modelKey.startsWith('mock-')).toBe(true);
    }
  });

  it('deliveryMode 与是否实现 poll 保持一致', () => {
    for (const kind of ['OPENAI', 'GEMINI', 'ARK_SEEDREAM', 'ALIYUN_WANX', 'BFL_FLUX'] as const) {
      const provider = getImageProvider(kind);
      const needsPoll = provider.describeDefaultModels().some((m) => m.limits.deliveryMode === 'async_poll');
      expect(typeof provider.poll === 'function').toBe(needsPoll);
    }
  });
});

// ---------------------------------------------------------------------------
// 模拟供应商(压测用)
// ---------------------------------------------------------------------------

describe('模拟供应商', () => {
  const creds: ProviderCredentials = { apiKey: 'not-used', baseUrl: 'not-used' };
  const baseReq: ImageGenerationRequest = {
    prompt: '压测用商品图',
    count: 2,
    size: '512x512',
    modelKey: 'mock-image-sync',
    extraParams: {},
  };

  it('同步模型直接返回合法 PNG,张数与请求一致', async () => {
    const provider = createMockImageProvider({ delayMs: 0, jitterMs: 0 });
    const outcome = await provider.submit(baseReq, creds);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.images).toHaveLength(2);
    expect(outcome.images[0]?.mimeType).toBe('image/png');
    // PNG magic number
    expect(Buffer.from(outcome.images[0]?.base64 ?? '', 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(outcome.images[0]?.width).toBe(512);
  });

  it('异步模型先 pending,延迟到点后 poll 出图', async () => {
    const provider = createMockImageProvider({ delayMs: 0, jitterMs: 0 });
    const submitted = await provider.submit({ ...baseReq, modelKey: 'mock-image-async' }, creds);
    expect(submitted.kind).toBe('pending');
    if (submitted.kind !== 'pending') return;

    const polled = await provider.poll(submitted.providerTaskId, creds);
    expect(polled.kind).toBe('completed');
  });

  it('查不到的任务按「结果未知」处理,而不是当作失败重试', async () => {
    const provider = createMockImageProvider();
    const polled = await provider.poll('mock-task-does-not-exist', creds);
    expect(polled.kind).toBe('failed');
    if (polled.kind !== 'failed') return;
    expect(polled.errorCode).toBe(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN);
    expect(polled.retryable).toBe(false);
  });

  it('可按配置注入限流 / 结果未知 / 普通失败,用于演练上层分支', async () => {
    const rateLimited = await createMockImageProvider({ rateLimitRate: 1, random: () => 0 }).submit(baseReq, creds);
    expect(rateLimited.kind === 'failed' && rateLimited.errorCode).toBe(ERROR_CODES.UPSTREAM_RATE_LIMITED);
    expect(rateLimited.kind === 'failed' && rateLimited.retryable).toBe(true);

    const unknown = await createMockImageProvider({ unknownRate: 1, random: () => 0 }).submit(baseReq, creds);
    expect(unknown.kind === 'failed' && unknown.errorCode).toBe(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN);
    expect(unknown.kind === 'failed' && unknown.retryable).toBe(false);

    const failed = await createMockImageProvider({ failureRate: 1, random: () => 0 }).submit(baseReq, creds);
    expect(failed.kind === 'failed' && failed.errorCode).toBe(ERROR_CODES.UPSTREAM_ERROR);
  });

  it('失败率为 0 时不注入任何失败', async () => {
    const provider = createMockImageProvider({ delayMs: 0, jitterMs: 0, random: () => 0 });
    for (let i = 0; i < 5; i += 1) {
      expect((await provider.submit(baseReq, creds)).kind).toBe('completed');
    }
  });

  it('testConnection 永远连通,且明确声明不发网络请求', async () => {
    const result = await createMockImageProvider().testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('[MOCK]');
  });
});