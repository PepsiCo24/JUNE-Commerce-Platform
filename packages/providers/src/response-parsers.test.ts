/**
 * 响应解析的纯函数测试。响应样例全部取自各家官方文档给出的示例结构。
 */

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@june/shared';

import { mapWanxPollResult, parseWanxPollResponse, parseWanxSubmitResponse } from './image/aliyun-wanx';
import { parseArkResponse } from './image/ark-seedream';
import { mapBflPollResult, parseBflPollResponse, parseBflSubmitResponse } from './image/bfl-flux';
import { parseInteractionResponse } from './image/gemini';
import { parseImagesResponse } from './image/openai';
import { createMockPng } from './image/mock';
import { finalizeStructuredText, parseChatCompletionResponse } from './text/openai-compatible';
import { normalizeGeminiFinishReason, parseGeminiTextResponse } from './text/gemini-text';

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe('OpenAI 响应解析', () => {
  it('解析文档示例的 ImagesResponse(base64 + 顶层 size / output_format)', () => {
    const parsed = parseImagesResponse({
      created: 1_713_833_628,
      data: [{ b64_json: 'QUJD' }],
      background: 'transparent',
      output_format: 'png',
      size: '1024x1024',
      quality: 'high',
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.images).toEqual([
      { base64: 'QUJD', mimeType: 'image/png', width: 1024, height: 1024 },
    ]);
  });

  it('dall-e 的 url 形态也能解析', () => {
    const parsed = parseImagesResponse({ created: 1, data: [{ url: 'https://example.com/a.png' }] });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.images[0]?.url).toBe('https://example.com/a.png');
  });

  it('data 为空或条目里既没有 url 也没有 b64_json 时报结构错误', () => {
    expect(parseImagesResponse({ created: 1, data: [] })).toEqual({ error: '响应缺少 data 数组' });
    expect(parseImagesResponse({ created: 1, data: [{ revised_prompt: 'x' }] })).toEqual({
      error: 'data 数组中没有可用的 b64_json 或 url',
    });
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe('Gemini 图片响应解析(三路兼容)', () => {
  it('形态 1:便捷属性 output_image', () => {
    const parsed = parseInteractionResponse({
      id: 'int_123',
      output_image: { data: 'QUJD', mime_type: 'image/jpeg' },
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.interactionId).toBe('int_123');
    expect(parsed.images).toEqual([{ base64: 'QUJD', mimeType: 'image/jpeg' }]);
  });

  it('形态 2:steps[].content[] 中的 image 块,text 块被跳过', () => {
    const parsed = parseInteractionResponse({
      id: 'int_456',
      steps: [
        { type: 'thought', summary: [{ type: 'text', text: '思考' }] },
        {
          type: 'model_output',
          content: [
            { type: 'text', text: '这是描述' },
            { type: 'image', mime_type: 'image/png', data: 'AAA' },
          ],
        },
      ],
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.images).toEqual([{ base64: 'AAA', mimeType: 'image/png' }]);
  });

  it('形态 3:generateContent 旧形态的 inline_data', () => {
    const parsed = parseInteractionResponse({
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'BBB' } }] } }],
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.images).toEqual([{ base64: 'BBB', mimeType: 'image/png' }]);
  });

  it('三种形态都不命中时给出明确的结构错误', () => {
    expect(parseInteractionResponse({ id: 'x', steps: [] })).toEqual({
      error: '响应中未找到图片内容块(已尝试 output_image / steps / candidates 三种形态)',
    });
  });
});

// ---------------------------------------------------------------------------
// 火山方舟 Seedream
// ---------------------------------------------------------------------------

describe('火山方舟 Seedream 响应解析', () => {
  it('解析文档示例的 data 数组,并按 size 回填宽高', () => {
    const parsed = parseArkResponse({
      model: 'doubao-seedream-5-0-pro-260628',
      created: 1_784_696_685,
      data: [
        { url: 'https://example.com/1.jpg', size: '2048x2048', output_format: 'jpeg' },
        { url: 'https://example.com/2.png', size: '1273x265', output_format: 'png' },
      ],
      usage: { generated_images: 2, output_tokens: 100, total_tokens: 100 },
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0]).toEqual({
      url: 'https://example.com/1.jpg',
      mimeType: 'image/jpeg',
      width: 2048,
      height: 2048,
    });
    expect(parsed.images[1]?.mimeType).toBe('image/png');
  });

  it('组图部分失败:成功项进 images,失败项进 perImageErrors', () => {
    const parsed = parseArkResponse({
      data: [
        { url: 'https://example.com/ok.jpg', size: '2048x2048', output_format: 'jpeg' },
        { error: { code: 'InternalError', message: '服务异常' } },
      ],
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.images).toHaveLength(1);
    expect(parsed.perImageErrors).toHaveLength(1);
    expect(parsed.perImageErrors[0]).toContain('InternalError');
  });

  it('顶层 error 且文案含审核字样时标记为 blocked', () => {
    const parsed = parseArkResponse({
      error: { code: 'OutputImageSensitiveContentDetected', message: '生成内容未通过审核' },
    });
    expect('error' in parsed).toBe(true);
    if (!('error' in parsed)) return;
    expect(parsed.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 阿里云通义万相
// ---------------------------------------------------------------------------

describe('阿里云通义万相响应解析与状态映射', () => {
  it('提交成功返回 task_id 与 PENDING', () => {
    expect(
      parseWanxSubmitResponse({
        output: { task_status: 'PENDING', task_id: '0385dc79-5ff8-4d82-bcb6-xxxxxx' },
        request_id: '4909100c',
      }),
    ).toEqual({ taskId: '0385dc79-5ff8-4d82-bcb6-xxxxxx', taskStatus: 'PENDING' });
  });

  it('提交失败时顶层 code/message 被抽出', () => {
    expect(
      parseWanxSubmitResponse({ code: 'InvalidApiKey', message: 'No API-key provided.', request_id: '7438d53d' }),
    ).toEqual({ error: 'InvalidApiKey / No API-key provided.' });
  });

  it('SUCCEEDED 时 results[].url 变成图片,失败项进 perImageErrors', () => {
    const parsed = parseWanxPollResponse({
      request_id: '85eaba38',
      output: {
        task_id: '86ecf553',
        task_status: 'SUCCEEDED',
        results: [
          { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/123/a1.png' },
          { code: 'InternalError.Timeout', message: 'timeout' },
        ],
        task_metrics: { TOTAL: 2, SUCCEEDED: 1, FAILED: 1 },
      },
      usage: { image_count: 1 },
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.images).toEqual([
      { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/123/a1.png', mimeType: 'image/png' },
    ]);
    expect(parsed.perImageErrors[0]).toContain('InternalError.Timeout');

    const outcome = mapWanxPollResult(parsed, 'task-1', 120);
    expect(outcome.kind).toBe('completed');
  });

  it('PENDING / RUNNING 映射为 pending 并给出建议轮询间隔', () => {
    for (const status of ['PENDING', 'RUNNING'] as const) {
      const outcome = mapWanxPollResult({ taskStatus: status, images: [], perImageErrors: [] }, 'task-1', 0);
      expect(outcome.kind).toBe('pending');
      if (outcome.kind !== 'pending') continue;
      expect(outcome.pollAfterMs).toBe(10_000);
    }
  });

  it('FAILED 可重试,CANCELED 不可重试', () => {
    const failed = mapWanxPollResult(
      { taskStatus: 'FAILED', images: [], perImageErrors: [], taskError: 'InvalidParameter / bad size' },
      'task-1',
      0,
    );
    expect(failed.kind).toBe('failed');
    if (failed.kind !== 'failed') return;
    expect(failed.errorCode).toBe(ERROR_CODES.UPSTREAM_ERROR);
    expect(failed.retryable).toBe(true);

    const canceled = mapWanxPollResult({ taskStatus: 'CANCELED', images: [], perImageErrors: [] }, 'task-1', 0);
    expect(canceled.kind === 'failed' && canceled.retryable).toBe(false);
  });

  it('UNKNOWN 判定为「结果未知」:不可重试,且带出 task_id 供核对', () => {
    const outcome = mapWanxPollResult({ taskStatus: 'UNKNOWN', images: [], perImageErrors: [] }, 'task-42', 0);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.errorCode).toBe(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN);
    expect(outcome.retryable).toBe(false);
    expect(outcome.providerTaskId).toBe('task-42');
  });

  it('SUCCEEDED 但没有任何 url 时视为结构异常,而不是假装成功', () => {
    const outcome = mapWanxPollResult(
      { taskStatus: 'SUCCEEDED', images: [], perImageErrors: ['x / y'] },
      'task-1',
      0,
    );
    expect(outcome.kind === 'failed' && outcome.errorCode).toBe(ERROR_CODES.UPSTREAM_ERROR);
  });
});

// ---------------------------------------------------------------------------
// BFL FLUX
// ---------------------------------------------------------------------------

describe('BFL FLUX 响应解析与状态映射', () => {
  it('提交返回 id + polling_url', () => {
    expect(
      parseBflSubmitResponse({ id: 'req-1', polling_url: 'https://api.bfl.ai/v1/get_result?id=req-1', cost: 4 }),
    ).toEqual({ id: 'req-1', pollingUrl: 'https://api.bfl.ai/v1/get_result?id=req-1' });
  });

  it('拿到 id 但缺 polling_url 时把 id 带出去(任务可能已计费)', () => {
    const parsed = parseBflSubmitResponse({ id: 'req-2' });
    expect('error' in parsed).toBe(true);
    if (!('error' in parsed)) return;
    expect(parsed.taskId).toBe('req-2');
  });

  it('Ready 时取 result.sample,并标注 10 分钟有效的链接', () => {
    const parsed = parseBflPollResponse({
      id: 'req-1',
      status: 'Ready',
      result: { sample: 'https://delivery.eu1.bfl.ai/x.png?sig=abc' },
      progress: 1,
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    const outcome = mapBflPollResult(parsed, 'poll-url', 500, 'image/png');
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.images[0]?.url).toBe('https://delivery.eu1.bfl.ai/x.png?sig=abc');
  });

  it('Pending / Reasoning / Generating 都是 pending', () => {
    for (const status of ['Pending', 'Reasoning', 'Generating'] as const) {
      const outcome = mapBflPollResult({ status }, 'poll-url', 0, 'image/png');
      expect(outcome.kind).toBe('pending');
    }
  });

  it('Request Moderated / Content Moderated 分别映射到输入 / 输出内容拦截', () => {
    const requestModerated = mapBflPollResult(
      { status: 'Request Moderated', details: 'Moderation Reasons: Violence' },
      'poll-url',
      0,
      'image/png',
    );
    expect(requestModerated.kind === 'failed' && requestModerated.errorCode).toBe(ERROR_CODES.CONTENT_BLOCKED_INPUT);

    const contentModerated = mapBflPollResult({ status: 'Content Moderated' }, 'poll-url', 0, 'image/png');
    expect(contentModerated.kind === 'failed' && contentModerated.errorCode).toBe(ERROR_CODES.CONTENT_BLOCKED_OUTPUT);
  });

  it('Task not found 判定为「结果未知」而不是失败:提交过就可能已计费', () => {
    const outcome = mapBflPollResult({ status: 'Task not found' }, 'poll-url', 0, 'image/png');
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.errorCode).toBe(ERROR_CODES.UPSTREAM_RESULT_UNKNOWN);
    expect(outcome.retryable).toBe(false);
    expect(outcome.providerTaskId).toBe('poll-url');
  });

  it('Error 状态任务已终结,可以重试', () => {
    const outcome = mapBflPollResult({ status: 'Error', details: 'internal' }, 'poll-url', 0, 'image/png');
    expect(outcome.kind === 'failed' && outcome.retryable).toBe(true);
  });

  it('Ready 但 result.sample 缺失时不假装成功', () => {
    const outcome = mapBflPollResult({ status: 'Ready' }, 'poll-url', 0, 'image/png');
    expect(outcome.kind === 'failed' && outcome.errorCode).toBe(ERROR_CODES.UPSTREAM_ERROR);
  });
});

// ---------------------------------------------------------------------------
// 文本适配器
// ---------------------------------------------------------------------------

describe('文本响应解析', () => {
  it('chat completions 取 choices[0].message.content', () => {
    const parsed = parseChatCompletionResponse({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"titles":["A"]}' } }],
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.raw).toBe('{"titles":["A"]}');
    expect(parsed.finishReason).toBe('stop');
  });

  it('message.refusal 被单独识别出来', () => {
    const parsed = parseChatCompletionResponse({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', refusal: '不能生成该内容' } }],
    });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.refusal).toBe('不能生成该内容');
  });

  it('Gemini 文本三路兼容:output_text / steps / candidates', () => {
    expect(parseGeminiTextResponse({ output_text: '{"a":1}' })).toEqual({ raw: '{"a":1}' });

    const fromSteps = parseGeminiTextResponse({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"b":2}' }] }],
    });
    expect(fromSteps).toEqual({ raw: '{"b":2}' });

    const fromCandidates = parseGeminiTextResponse({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"c":3}' }] } }],
    });
    expect(fromCandidates).toEqual({ raw: '{"c":3}', finishReason: 'STOP' });
  });

  it('Gemini 的 MAX_TOKENS 归一化成 OpenAI 的 length', () => {
    expect(normalizeGeminiFinishReason('MAX_TOKENS')).toBe('length');
    expect(normalizeGeminiFinishReason('STOP')).toBe('STOP');
    expect(normalizeGeminiFinishReason(undefined)).toBeUndefined();
  });

  it('finalizeStructuredText 只判断 JSON 合法性,业务结构留给上层 zod', () => {
    const ok = finalizeStructuredText('X', '{"titles":["A"],"body":"B"}', 'stop', 100);
    expect(ok.kind).toBe('completed');
    if (ok.kind !== 'completed') return;
    // 注意:parsed 里没有 highlights / keywords,适配器不补默认值
    expect(ok.parsed).toEqual({ titles: ['A'], body: 'B' });
    expect(ok.raw).toBe('{"titles":["A"],"body":"B"}');
  });

  it('非法 JSON 映射为 CONTENT_STRUCTURE_INVALID 且可重试', () => {
    const bad = finalizeStructuredText('X', '这不是 JSON', 'stop', 100);
    expect(bad.kind).toBe('failed');
    if (bad.kind !== 'failed') return;
    expect(bad.errorCode).toBe(ERROR_CODES.CONTENT_STRUCTURE_INVALID);
    expect(bad.retryable).toBe(true);
  });

  it('finish_reason = length 时直接判定为被截断,不再尝试解析', () => {
    const truncated = finalizeStructuredText('X', '{"titles":["A"', 'length', 100);
    expect(truncated.kind === 'failed' && truncated.errorCode).toBe(ERROR_CODES.CONTENT_STRUCTURE_INVALID);
    if (truncated.kind !== 'failed') return;
    expect(truncated.message).toContain('maxOutputTokens');
  });
});

// ---------------------------------------------------------------------------
// 模拟供应商
// ---------------------------------------------------------------------------

describe('模拟供应商生成的 PNG', () => {
  it('是结构合法的 PNG(签名 + IHDR + IDAT + IEND)', () => {
    const png = createMockPng(128, 128);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
    expect(png.includes(Buffer.from('IDAT', 'ascii'))).toBe(true);
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
  });
});
