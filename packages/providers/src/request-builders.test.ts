/**
 * 请求体构造的纯函数测试。不发起任何真实网络请求。
 *
 * 重点覆盖各家「容易踩」的差异点:
 *  - OpenAI:GPT image 系列不能传 response_format
 *  - Gemini:参考图是 input 数组里的内容块,base64 不带 data URI 前缀
 *  - Ark:参考图必须是 data URI;watermark 上游默认 true 必须显式关闭;组图靠 max_images
 *  - 万相:size 分隔符是 `*`;n 上游默认 4 必须显式传
 *  - FLUX:参考图是编号字段 input_image / input_image_2...;没有 n 参数
 */

import { describe, expect, it } from 'vitest';

import { buildArkBody, toArkDataUri } from './image/ark-seedream';
import { buildWanxSubmitBody, toWanxSize } from './image/aliyun-wanx';
import { buildBflSubmitBody, buildBflSubmitUrl } from './image/bfl-flux';
import { buildInteractionBody } from './image/gemini';
import { buildGenerationBody, buildEditFormData } from './image/openai';
import { buildChatCompletionBody } from './text/openai-compatible';
import { buildGeminiTextBody } from './text/gemini-text';
import type { ImageGenerationRequest, StructuredTextRequest } from './types';

function imageRequest(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: '白色陶瓷马克杯,棚拍,柔光',
    count: 1,
    modelKey: 'test-model',
    extraParams: {},
    ...overrides,
  };
}

const REF_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe('OpenAI 请求体构造', () => {
  it('GPT image 系列不传 response_format(上游只返回 base64,传了会被拒)', () => {
    const body = buildGenerationBody(
      imageRequest({ modelKey: 'gpt-image-1.5', size: '1024x1536', count: 3 }),
    );
    expect(body.model).toBe('gpt-image-1.5');
    expect(body.n).toBe(3);
    expect(body.size).toBe('1024x1536');
    expect(body.response_format).toBeUndefined();
  });

  it('dall-e 系列默认请求 b64_json,避免依赖 60 分钟有效期的临时链接', () => {
    const body = buildGenerationBody(imageRequest({ modelKey: 'dall-e-3', size: '1792x1024' }));
    expect(body.response_format).toBe('b64_json');
  });

  it('只接受白名单内的 extraParams,未识别的键被忽略而不是透传', () => {
    const body = buildGenerationBody(
      imageRequest({
        modelKey: 'gpt-image-1.5',
        extraParams: { quality: 'high', moderation: 'nope', 未知字段: '危险值' },
      }),
    );
    expect(body.quality).toBe('high');
    expect(body.moderation).toBeUndefined();
    expect(body).not.toHaveProperty('未知字段');
  });

  it('style 只对 dall-e-3 生效', () => {
    expect(buildGenerationBody(imageRequest({ modelKey: 'dall-e-3', extraParams: { style: 'natural' } })).style).toBe(
      'natural',
    );
    expect(
      buildGenerationBody(imageRequest({ modelKey: 'gpt-image-1.5', extraParams: { style: 'natural' } })).style,
    ).toBeUndefined();
  });

  it('width/height 模式回落成 WIDTHxHEIGHT 字符串', () => {
    const body = buildGenerationBody(imageRequest({ modelKey: 'gpt-image-2', width: 1536, height: 864 }));
    expect(body.size).toBe('1536x864');
  });

  it('图像编辑走 multipart:单图用 image,多图用 image[]', () => {
    const single = buildEditFormData(
      imageRequest({
        modelKey: 'gpt-image-1.5',
        referenceImages: [{ data: REF_BYTES, mimeType: 'image/png' }],
      }),
    );
    expect(single.getAll('image')).toHaveLength(1);
    expect(single.getAll('image[]')).toHaveLength(0);
    expect(single.get('prompt')).toBe('白色陶瓷马克杯,棚拍,柔光');

    const multi = buildEditFormData(
      imageRequest({
        modelKey: 'gpt-image-1.5',
        referenceImages: [
          { data: REF_BYTES, mimeType: 'image/png' },
          { data: REF_BYTES, mimeType: 'image/jpeg' },
        ],
      }),
    );
    expect(multi.getAll('image[]')).toHaveLength(2);
    expect(multi.getAll('image')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe('Gemini 请求体构造', () => {
  it('参考图作为 input 数组里的 image 块,data 是不带前缀的 base64', () => {
    const body = buildInteractionBody(
      imageRequest({
        modelKey: 'gemini-3.1-flash-image',
        referenceImages: [{ data: REF_BYTES, mimeType: 'image/png' }],
      }),
    );
    expect(body.input[0]).toEqual({ type: 'text', text: '白色陶瓷马克杯,棚拍,柔光' });
    expect(body.input[1]).toEqual({
      type: 'image',
      mime_type: 'image/png',
      data: REF_BYTES.toString('base64'),
    });
    expect(body.input[1]).not.toHaveProperty('data', expect.stringContaining('data:'));
  });

  it('只接受文档列出的宽高比,非法值被丢弃', () => {
    expect(buildInteractionBody(imageRequest({ aspectRatio: '21:9' })).response_format.aspect_ratio).toBe('21:9');
    expect(buildInteractionBody(imageRequest({ aspectRatio: '7:11' })).response_format.aspect_ratio).toBeUndefined();
  });

  it('image_size 必须是大写 K 的白名单值', () => {
    expect(buildInteractionBody(imageRequest({ extraParams: { image_size: '2K' } })).response_format.image_size).toBe(
      '2K',
    );
    // 文档明确小写会被上游拒绝,适配器提前拦掉
    expect(
      buildInteractionBody(imageRequest({ extraParams: { image_size: '2k' } })).response_format.image_size,
    ).toBeUndefined();
  });

  it('默认 store=false,不让商品图在上游留存', () => {
    expect(buildInteractionBody(imageRequest()).store).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 火山方舟 Seedream
// ---------------------------------------------------------------------------

describe('火山方舟 Seedream 请求体构造', () => {
  it('参考图转成小写 mime 的 data URI(文档强制要求)', () => {
    expect(toArkDataUri({ data: REF_BYTES, mimeType: 'IMAGE/PNG' })).toBe(
      `data:image/png;base64,${REF_BYTES.toString('base64')}`,
    );
  });

  it('单张参考图用字符串,多张用字符串数组', () => {
    const single = buildArkBody(
      imageRequest({ referenceImages: [{ data: REF_BYTES, mimeType: 'image/png' }] }),
    );
    expect(typeof single.image).toBe('string');

    const multi = buildArkBody(
      imageRequest({
        referenceImages: [
          { data: REF_BYTES, mimeType: 'image/png' },
          { data: REF_BYTES, mimeType: 'image/jpeg' },
        ],
      }),
    );
    expect(Array.isArray(multi.image)).toBe(true);
    expect(multi.image).toHaveLength(2);
  });

  it('watermark 上游默认 true,适配器必须显式传 false', () => {
    expect(buildArkBody(imageRequest()).watermark).toBe(false);
    expect(buildArkBody(imageRequest({ extraParams: { watermark: true } })).watermark).toBe(true);
  });

  it('count=1 关闭组图;count>1 开组图并把 max_images 收在 15 - 参考图数以内', () => {
    expect(buildArkBody(imageRequest({ count: 1 })).sequential_image_generation).toBe('disabled');

    const group = buildArkBody(imageRequest({ count: 5 }));
    expect(group.sequential_image_generation).toBe('auto');
    expect(group.sequential_image_generation_options).toEqual({ max_images: 5 });

    // 参考图 12 张时,「参考图 + 生成图 ≤ 15」只剩 3 张额度
    const withRefs = buildArkBody(
      imageRequest({
        count: 10,
        referenceImages: Array.from({ length: 12 }, () => ({ data: REF_BYTES, mimeType: 'image/png' })),
      }),
    );
    expect(withRefs.sequential_image_generation_options).toEqual({ max_images: 3 });
  });

  it('size_tier 优先于像素尺寸', () => {
    expect(buildArkBody(imageRequest({ size: '2048x2048', extraParams: { size_tier: '2K' } })).size).toBe('2K');
    expect(buildArkBody(imageRequest({ size: '2048x2048' })).size).toBe('2048x2048');
  });
});

// ---------------------------------------------------------------------------
// 阿里云通义万相
// ---------------------------------------------------------------------------

describe('阿里云通义万相请求体构造', () => {
  it('size 分隔符必须是星号,不是小写 x', () => {
    expect(toWanxSize(imageRequest({ size: '1024x1024' }))).toBe('1024*1024');
    expect(toWanxSize(imageRequest({ width: 1104, height: 1472 }))).toBe('1104*1472');
    expect(toWanxSize(imageRequest())).toBeUndefined();
  });

  it('n 永远显式传(上游默认 4,不传会按 4 张计费)', () => {
    expect(buildWanxSubmitBody(imageRequest({ count: 1 })).parameters.n).toBe(1);
    expect(buildWanxSubmitBody(imageRequest({ count: 3 })).parameters.n).toBe(3);
  });

  it('negative_prompt 与 seed 原生支持,seed 越界时不传', () => {
    const body = buildWanxSubmitBody(imageRequest({ negativePrompt: '人物', seed: 12345 }));
    expect(body.input.negative_prompt).toBe('人物');
    expect(body.parameters.seed).toBe(12345);

    expect(buildWanxSubmitBody(imageRequest({ seed: 2_147_483_648 })).parameters.seed).toBeUndefined();
    expect(buildWanxSubmitBody(imageRequest({ negativePrompt: '   ' })).input.negative_prompt).toBeUndefined();
  });

  it('prompt_extend 默认关闭,避免智能改写引入版权内容触发审核', () => {
    expect(buildWanxSubmitBody(imageRequest()).parameters.prompt_extend).toBe(false);
    expect(
      buildWanxSubmitBody(imageRequest({ extraParams: { prompt_extend: true } })).parameters.prompt_extend,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BFL FLUX
// ---------------------------------------------------------------------------

describe('BFL FLUX 请求体构造', () => {
  it('端点即模型名', () => {
    expect(buildBflSubmitUrl('https://api.bfl.ai/v1/', 'flux-2-pro')).toBe('https://api.bfl.ai/v1/flux-2-pro');
    expect(buildBflSubmitUrl('https://api.bfl.ai/v1', '/flux-2-max')).toBe('https://api.bfl.ai/v1/flux-2-max');
  });

  it('参考图是编号字段 input_image / input_image_2 ...,最多 8 张', () => {
    const body = buildBflSubmitBody(
      imageRequest({
        referenceImages: Array.from({ length: 10 }, () => ({ data: REF_BYTES, mimeType: 'image/png' })),
      }),
    );
    expect(body['input_image']).toBe(REF_BYTES.toString('base64'));
    expect(body['input_image_2']).toBeDefined();
    expect(body['input_image_8']).toBeDefined();
    // 第 9、10 张被截断:上游只有 input_image ~ input_image_8
    expect(body['input_image_9']).toBeUndefined();
    expect(body['input_image_10']).toBeUndefined();
  });

  it('没有 n 参数:单次固定 1 张,批量由上层拆分', () => {
    const body = buildBflSubmitBody(imageRequest({ count: 4 }));
    expect(body).not.toHaveProperty('n');
    expect(body).not.toHaveProperty('count');
  });

  it('默认关闭 prompt upsampling,保证提示词可复现', () => {
    expect(buildBflSubmitBody(imageRequest()).disable_pup).toBe(true);
    expect(buildBflSubmitBody(imageRequest({ extraParams: { disable_pup: false } })).disable_pup).toBe(false);
  });

  it('safety_tolerance 只接受 0~5', () => {
    expect(buildBflSubmitBody(imageRequest({ extraParams: { safety_tolerance: 4 } })).safety_tolerance).toBe(4);
    expect(buildBflSubmitBody(imageRequest({ extraParams: { safety_tolerance: 6 } })).safety_tolerance).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 文本适配器
// ---------------------------------------------------------------------------

function textRequest(overrides: Partial<StructuredTextRequest> = {}): StructuredTextRequest {
  return {
    modelKey: 'gpt-4.1-mini',
    systemPrompt: '你是电商文案助手',
    userPrompt: '为这款马克杯写标题与正文',
    jsonSchema: { type: 'object', properties: { titles: { type: 'array', items: { type: 'string' } } } },
    ...overrides,
  };
}

describe('OpenAI 兼容 chat completions 请求体构造', () => {
  it('使用 response_format.json_schema,而不是 json_object', () => {
    const body = buildChatCompletionBody(textRequest());
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema).toEqual(textRequest().jsonSchema);
    expect(body.response_format.json_schema.strict).toBe(false);
  });

  it('strict 可显式开启', () => {
    expect(buildChatCompletionBody(textRequest(), true).response_format.json_schema.strict).toBe(true);
  });

  it('json_schema.name 非法时回落到默认名', () => {
    expect(buildChatCompletionBody(textRequest({ schemaName: 'copy_result_v1' })).response_format.json_schema.name).toBe(
      'copy_result_v1',
    );
    // 含空格与中文,不符合 ^[a-zA-Z0-9_-]{1,64}$
    expect(buildChatCompletionBody(textRequest({ schemaName: '文案 结果' })).response_format.json_schema.name).toBe(
      'june_copy_result',
    );
  });

  it('用 max_completion_tokens 而不是已弃用的 max_tokens', () => {
    const body = buildChatCompletionBody(textRequest({ maxOutputTokens: 2048 }));
    expect(body.max_completion_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('systemPrompt 走 role=system 的消息', () => {
    const body = buildChatCompletionBody(textRequest());
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是电商文案助手' });
    expect(body.n).toBe(1);
  });
});

describe('Gemini 文本请求体构造', () => {
  it('结构化输出走 response_format.mime_type + schema,不是 json_schema', () => {
    const body = buildGeminiTextBody(textRequest({ modelKey: 'gemini-3.8-flash' }));
    expect(body.response_format).toEqual({
      type: 'text',
      mime_type: 'application/json',
      schema: textRequest().jsonSchema,
    });
  });

  it('systemPrompt 走独立的 system_instruction 字段,不混进 input', () => {
    const body = buildGeminiTextBody(textRequest());
    expect(body.system_instruction).toBe('你是电商文案助手');
    expect(body.input).toBe('为这款马克杯写标题与正文');
    expect(body.input).not.toContain('电商文案助手');
  });

  it('maxOutputTokens 落在 generation_config 内', () => {
    expect(buildGeminiTextBody(textRequest({ maxOutputTokens: 4096 })).generation_config).toEqual({
      max_output_tokens: 4096,
    });
    expect(buildGeminiTextBody(textRequest()).generation_config).toBeUndefined();
  });
});
