/**
 * Google Gemini 文本结构化输出适配器(独立协议,非 OpenAI 兼容)。
 *
 * 核对来源(官方):
 *  - 结构化输出 https://ai.google.dev/gemini-api/docs/structured-output
 *  - Interactions API 概览 https://ai.google.dev/gemini-api/docs/interactions-overview
 * 核对日期:2026-09-16
 *
 * 形态:**同步**。POST {baseUrl}/interactions 直接返回内容。
 *
 * 与 OpenAI 协议的关键差异(这也是选它作为「第二种独立协议」的原因):
 *  - 认证走请求头 `x-goog-api-key`,不是 Authorization: Bearer;
 *  - 没有 messages 数组,输入是 `input`(字符串或内容块数组);
 *    system 提示词走独立的 `system_instruction` 字段,不是 role: 'system' 的消息;
 *  - 结构化输出不是 response_format.json_schema,而是:
 *      response_format: { type: 'text', mime_type: 'application/json', schema: { ... } }
 *    即用 mime_type 声明「要 JSON」+ schema 声明结构(对应旧 generateContent 协议里的
 *    responseMimeType / responseSchema 两个字段);
 *  - 结果不在 choices[].message.content,而在 interaction 的输出步骤里。
 *
 * 文档明确的字段(已核对,来自官方 REST cURL 示例):
 *  - POST https://generativelanguage.googleapis.com/v1beta/interactions
 *  - 请求头:x-goog-api-key、Content-Type: application/json
 *  - 请求体:{ model, input, response_format: { type: 'text',
 *              mime_type: 'application/json', schema: <JSON Schema> }, stream? }
 *  - schema 支持 object / array / string / integer / boolean、enum、anyOf、
 *    以及 `$ref: "#"` 形式的递归引用
 *  - 官方示例用 `Recipe.model_validate_json(interaction.output_text)` 取结果,
 *    即输出是一个 JSON **字符串**,需要调用方自行反序列化 —— 与本适配器
 *    「只返回 raw + parsed,结构校验交给上层」的约定一致
 *  - store 可设为 false 走无状态模式(避免商品资料在上游留存 55 天 / 1 天)
 *
 * 待真实联调(因此本文件模型 limits.verified = false):
 *  - **响应 JSON 的确切字段名**。官方结构化输出文档页只给出请求侧 REST 示例,
 *    响应侧仅以 SDK 属性 `interaction.output_text` 出现,未展示原始 JSON。
 *    parseGeminiTextResponse 做了三路兼容(output_text / steps[].content[].text /
 *    candidates[].content.parts[].text),首次联调必须打一次真实响应确认后收敛。
 *  - **maxOutputTokens 的传参位置**。图像文档展示了 generation_config.thinking_level,
 *    但未展示文本输出 token 上限的字段名(旧 generateContent 协议叫
 *    generationConfig.maxOutputTokens)。本适配器按 `generation_config.max_output_tokens`
 *    传递,属于合理推断而非文档确认。
 *  - **system 提示词字段名**。Interactions 概览把 `system_instruction` 列为
 *    interaction 作用域参数(与 tools、generation_config 并列),但该文档页未给出
 *    其 REST 形态示例,故字段名待确认。
 *  - **错误体结构**与 429 是否带 Retry-After 均未在文档说明。
 */

import { ERROR_CODES } from '@june/shared';

import {
  classifyHttpFailure,
  classifyTransportFailure,
  httpCall,
  malformedResponse,
  type CallPhase,
} from '../http';
import { buildLimits } from '../limits';
import { sanitizeUpstreamMessage } from '../sanitize';
import { extractGeminiError, GEMINI_DEFAULT_BASE_URL } from '../image/gemini';
import { trimTrailingSlash } from '../image/openai';
import { finalizeStructuredText } from './openai-compatible';
import type {
  ConnectionTestResult,
  ModelDescriptor,
  ProviderCallOptions,
  ProviderCredentials,
  StructuredTextOutcome,
  StructuredTextRequest,
  TextProvider,
} from '../types';

const PROVIDER_LABEL = 'Gemini Text';
const DOCS_URL = 'https://ai.google.dev/gemini-api/docs/structured-output';

// ---------------------------------------------------------------------------
// 请求体构造
// ---------------------------------------------------------------------------

export interface GeminiTextBody {
  model: string;
  input: string;
  response_format: {
    type: 'text';
    /** 声明「要 JSON」;对应旧 generateContent 协议的 responseMimeType */
    mime_type: 'application/json';
    /** 对应旧 generateContent 协议的 responseSchema */
    schema: Record<string, unknown>;
  };
  /** 待真实联调:字段名参考 Interactions 概览的参数列表,未见 REST 示例 */
  system_instruction?: string;
  /** 待真实联调:max_output_tokens 的确切字段名未在文档给出 */
  generation_config?: { max_output_tokens?: number; temperature?: number };
  store: boolean;
}

export function buildGeminiTextBody(req: StructuredTextRequest): GeminiTextBody {
  const body: GeminiTextBody = {
    model: req.modelKey,
    input: req.userPrompt,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: req.jsonSchema,
    },
    // 不使用 previous_interaction_id 多轮能力,关闭服务端留存
    store: false,
  };

  if (req.systemPrompt.trim().length > 0) {
    body.system_instruction = req.systemPrompt;
  }

  const generationConfig: { max_output_tokens?: number; temperature?: number } = {};
  if (typeof req.maxOutputTokens === 'number' && req.maxOutputTokens > 0) {
    generationConfig.max_output_tokens = req.maxOutputTokens;
  }
  if (typeof req.temperature === 'number') {
    generationConfig.temperature = req.temperature;
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generation_config = generationConfig;
  }

  return body;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

export interface ParsedGeminiText {
  raw: string;
  finishReason?: string;
}

/**
 * 解析文本输出。
 * 待真实联调:三种形态按优先级尝试,联调后应只保留真实命中的那一条。
 *  1. output_text(便捷属性)
 *  2. steps[] 中 type === 'model_output' 的 content[] 内 type === 'text' 的块
 *  3. candidates[].content.parts[].text(generateContent 旧形态)
 */
export function parseGeminiTextResponse(payload: unknown): ParsedGeminiText | { error: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: '响应不是 JSON 对象' };
  }
  const root = payload as Record<string, unknown>;

  const outputText = root['output_text'];
  if (typeof outputText === 'string' && outputText.length > 0) {
    return { raw: outputText };
  }

  const chunks: string[] = [];
  if (Array.isArray(root['steps'])) {
    for (const step of root['steps'] as unknown[]) {
      if (typeof step !== 'object' || step === null) continue;
      const stepObj = step as Record<string, unknown>;
      if (stepObj['type'] !== 'model_output') continue;
      const content = stepObj['content'];
      if (!Array.isArray(content)) continue;
      for (const block of content as unknown[]) {
        if (typeof block !== 'object' || block === null) continue;
        const blockObj = block as Record<string, unknown>;
        if (blockObj['type'] !== 'text') continue;
        const text = blockObj['text'];
        if (typeof text === 'string' && text.length > 0) chunks.push(text);
      }
    }
  }

  let finishReason: string | undefined;
  if (chunks.length === 0 && Array.isArray(root['candidates'])) {
    for (const candidate of root['candidates'] as unknown[]) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const candidateObj = candidate as Record<string, unknown>;
      const reason = candidateObj['finishReason'] ?? candidateObj['finish_reason'];
      if (typeof reason === 'string' && finishReason === undefined) finishReason = reason;
      const content = candidateObj['content'];
      if (typeof content !== 'object' || content === null) continue;
      const parts = (content as Record<string, unknown>)['parts'];
      if (!Array.isArray(parts)) continue;
      for (const part of parts as unknown[]) {
        if (typeof part !== 'object' || part === null) continue;
        const text = (part as Record<string, unknown>)['text'];
        if (typeof text === 'string' && text.length > 0) chunks.push(text);
      }
    }
  }

  if (chunks.length === 0) {
    return { error: '响应中未找到文本内容(已尝试 output_text / steps / candidates 三种形态)' };
  }
  return { raw: chunks.join(''), ...(finishReason ? { finishReason } : {}) };
}

/**
 * Gemini 的截断原因用 MAX_TOKENS,而 OpenAI 用 length。
 * finalizeStructuredText 只认 'length',这里做一次归一化。
 */
export function normalizeGeminiFinishReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return reason.toUpperCase() === 'MAX_TOKENS' ? 'length' : reason;
}

// ---------------------------------------------------------------------------
// 模型能力
// ---------------------------------------------------------------------------

export function describeGeminiTextModels(): ModelDescriptor[] {
  const limits = buildLimits({
    maxOutputs: 1,
    maxOutputsPerCall: 1,
    maxReferenceImages: 0,
    sizes: [],
    deliveryMode: 'sync',
    supportsStructuredOutput: true,
    // 待真实联调:各模型的输出 token 上限未在结构化输出文档页给出,取保守值
    maxOutputTokens: 8_192,
    docsUrl: DOCS_URL,
    // 响应字段名与 max_output_tokens 字段名未经官方 REST 文档确认
    verified: false,
  });

  return [
    {
      // 官方结构化输出文档的 REST 示例使用的模型
      modelKey: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash(结构化输出)',
      capabilities: ['TEXT'],
      limits,
    },
    {
      modelKey: 'gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash(结构化输出)',
      capabilities: ['TEXT'],
      limits,
    },
  ];
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export class GeminiTextProvider implements TextProvider {
  readonly kind = 'GEMINI' as const;

  describeDefaultModels(): ModelDescriptor[] {
    return describeGeminiTextModels();
  }

  async generateStructured(
    req: StructuredTextRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<StructuredTextOutcome> {
    const phase: CallPhase = 'submit';
    const baseUrl = trimTrailingSlash(creds.baseUrl || GEMINI_DEFAULT_BASE_URL);

    const outcome = await httpCall({
      url: `${baseUrl}/interactions`,
      method: 'POST',
      headers: {
        'x-goog-api-key': creds.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      json: buildGeminiTextBody(req),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return classifyTransportFailure(phase, PROVIDER_LABEL, outcome.transport);
    }

    const { response, durationMs } = outcome;
    if (response.status < 200 || response.status >= 300) {
      const { detail, structured } = extractGeminiError(response.json ?? response.bodyText);
      return classifyHttpFailure({
        phase,
        providerLabel: PROVIDER_LABEL,
        response,
        upstreamDetail: detail,
        hasStructuredError: structured,
      });
    }

    const parsed = parseGeminiTextResponse(response.json);
    if ('error' in parsed) {
      return malformedResponse(PROVIDER_LABEL, parsed.error, response.status);
    }

    return finalizeStructuredText(
      PROVIDER_LABEL,
      parsed.raw,
      normalizeGeminiFinishReason(parsed.finishReason),
      durationMs,
      response.status,
    );
  }

  async testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult> {
    const baseUrl = trimTrailingSlash(creds.baseUrl || GEMINI_DEFAULT_BASE_URL);
    const outcome = await httpCall({
      url: `${baseUrl}/models`,
      method: 'GET',
      headers: { 'x-goog-api-key': creds.apiKey, accept: 'application/json' },
      timeoutMs: options?.timeoutMs ?? 15_000,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return {
        ok: false,
        message: sanitizeUpstreamMessage(outcome.transport.detail),
        latencyMs: outcome.durationMs,
        errorCode: ERROR_CODES.UPSTREAM_TIMEOUT,
      };
    }
    const ok = outcome.response.status >= 200 && outcome.response.status < 300;
    return {
      ok,
      message: ok ? '连接正常' : sanitizeUpstreamMessage(extractGeminiError(outcome.response.json).detail),
      httpStatus: outcome.response.status,
      latencyMs: outcome.durationMs,
      ...(ok ? {} : { errorCode: ERROR_CODES.UPSTREAM_ERROR }),
    };
  }
}
