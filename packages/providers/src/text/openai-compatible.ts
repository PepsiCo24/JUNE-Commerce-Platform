/**
 * OpenAI 兼容 chat completions 文本适配器(结构化输出)。
 *
 * 核对来源(官方):
 *  - OpenAI 官方 OpenAPI 规范 https://github.com/openai/openai-openapi
 *    (raw: https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml)
 *    使用 CreateChatCompletionRequest / ResponseFormatJsonSchema /
 *    ResponseFormatJsonSchemaSchema / ErrorResponse 定义
 *  - 结构化输出指南 https://platform.openai.com/docs/guides/structured-outputs
 * 核对日期:2026-09-16
 *
 * 形态:**同步**。POST {baseUrl}/chat/completions 直接返回内容。
 *
 * 文档明确的字段(已核对):
 *  - 端点:POST {baseUrl}/chat/completions;认证 `Authorization: Bearer <apiKey>`
 *  - 结构化输出的正确用法是 response_format,而 response_format 是三者之一:
 *      { type: 'text' }
 *      { type: 'json_object' }                        ← 只保证是合法 JSON,不保证结构
 *      { type: 'json_schema', json_schema: { ... } }   ← 保证贴合 schema,应优先使用
 *    json_schema 对象的字段:
 *      name(必选,a-z A-Z 0-9 下划线短横,最长 64)
 *      schema(JSON Schema)
 *      strict(布尔,默认 false;为 true 时严格贴合 schema,但只支持 JSON Schema 的子集)
 *      description(可选,供模型理解用途)
 *  - 输出长度用 **max_completion_tokens**(max_tokens 已被标记弃用)
 *  - 错误体:{ error: { code, message, param, type } }
 *
 * strict 模式的取舍(重要):
 *  官方文档说明 strict = true 时只支持 JSON Schema 的子集,常见约束是:
 *  对象必须 additionalProperties: false、所有属性必须列在 required 里。
 *  本平台的 copyResultPayloadSchema 含可选字段(highlights / keywords 有默认值),
 *  直接开 strict 可能被上游拒绝。因此:
 *   - 默认 strict = false(仅作为格式引导),
 *   - 由 extraParams / 调用方显式开启 strict,并自行保证 schema 落在受支持子集内。
 *  无论 strict 真假,**返回值一律不被信任**:适配器只返回 raw + parsed,
 *  业务结构校验由上层用 copyResultPayloadSchema 完成,不合规则走
 *  CONTENT_STRUCTURE_INVALID。
 *
 * 待真实联调:
 *  - 本适配器面向「OpenAI 兼容」网关(自建 vLLM / one-api / 各家兼容层)。
 *    第三方兼容层对 response_format.json_schema 的支持程度参差不齐,
 *    部分只支持 json_object。首次接入每个网关都要单独验证,
 *    因此 OPENAI_COMPATIBLE 的模型 limits.verified = false;
 *    直连 api.openai.com 的官方模型 verified = true。
 *  - 限流响应头:OpenAI 返回标准 Retry-After 及 x-ratelimit-* 系列,
 *    但兼容网关不保证,交由通用逻辑解析。
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
import { extractOpenAiError, trimTrailingSlash, OPENAI_DEFAULT_BASE_URL } from '../image/openai';
import type {
  ConnectionTestResult,
  ModelDescriptor,
  ProviderCallOptions,
  ProviderCredentials,
  ProviderKind,
  StructuredTextOutcome,
  StructuredTextRequest,
  TextProvider,
} from '../types';

const DOCS_URL = 'https://platform.openai.com/docs/guides/structured-outputs';

/** json_schema.name 的合法格式(文档:a-z A-Z 0-9 下划线短横,最长 64) */
const SCHEMA_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_SCHEMA_NAME = 'june_copy_result';

// ---------------------------------------------------------------------------
// 请求体构造
// ---------------------------------------------------------------------------

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionBody {
  model: string;
  messages: ChatCompletionMessage[];
  response_format: {
    type: 'json_schema';
    json_schema: {
      name: string;
      schema: Record<string, unknown>;
      strict: boolean;
    };
  };
  max_completion_tokens?: number;
  temperature?: number;
  /** 只取一个候选,避免多倍计费 */
  n: 1;
  stream: false;
}

export function buildChatCompletionBody(req: StructuredTextRequest, strict = false): ChatCompletionBody {
  const name =
    req.schemaName && SCHEMA_NAME_PATTERN.test(req.schemaName) ? req.schemaName : DEFAULT_SCHEMA_NAME;

  const body: ChatCompletionBody = {
    model: req.modelKey,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userPrompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name, schema: req.jsonSchema, strict },
    },
    n: 1,
    stream: false,
  };

  if (typeof req.maxOutputTokens === 'number' && req.maxOutputTokens > 0) {
    // 文档明确:max_tokens 已弃用,应使用 max_completion_tokens
    body.max_completion_tokens = req.maxOutputTokens;
  }
  if (typeof req.temperature === 'number') {
    body.temperature = req.temperature;
  }

  return body;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

export interface ParsedChatCompletion {
  raw: string;
  finishReason?: string;
  /** 上游主动声明拒答时的说明(部分模型返回 message.refusal) */
  refusal?: string;
}

export function parseChatCompletionResponse(payload: unknown): ParsedChatCompletion | { error: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: '响应不是 JSON 对象' };
  }
  const root = payload as Record<string, unknown>;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return { error: '响应缺少 choices 数组' };
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    return { error: 'choices[0] 不是对象' };
  }
  const choice = first as Record<string, unknown>;
  const finishReason = typeof choice['finish_reason'] === 'string' ? (choice['finish_reason'] as string) : undefined;

  const message = choice['message'];
  if (typeof message !== 'object' || message === null) {
    return { error: 'choices[0].message 缺失' };
  }
  const messageObj = message as Record<string, unknown>;

  const refusal = messageObj['refusal'];
  if (typeof refusal === 'string' && refusal.length > 0) {
    return {
      raw: '',
      refusal,
      ...(finishReason ? { finishReason } : {}),
    };
  }

  const content = messageObj['content'];
  if (typeof content !== 'string' || content.length === 0) {
    return { error: 'choices[0].message.content 为空' };
  }

  return { raw: content, ...(finishReason ? { finishReason } : {}) };
}

// ---------------------------------------------------------------------------
// 模型能力
// ---------------------------------------------------------------------------

function textLimits(args: { maxOutputTokens: number; verified: boolean }): ReturnType<typeof buildLimits> {
  return buildLimits({
    // 文本模型不出图,图像相关字段保持最保守值
    maxOutputs: 1,
    maxOutputsPerCall: 1,
    maxReferenceImages: 0,
    sizes: [],
    deliveryMode: 'sync',
    supportsStructuredOutput: true,
    maxOutputTokens: args.maxOutputTokens,
    docsUrl: DOCS_URL,
    verified: args.verified,
  });
}

/**
 * 直连 OpenAI 官方端点时的默认模型。
 * 待真实联调:具体模型名与其 max_completion_tokens 上限由后台按账号可用模型配置,
 * 这里只给出保守的默认值,不冒充「所有账号都可用」。
 */
export function describeOpenAiTextModels(): ModelDescriptor[] {
  return [
    {
      modelKey: 'gpt-4.1-mini',
      displayName: 'OpenAI gpt-4.1-mini(结构化输出)',
      capabilities: ['TEXT'],
      limits: textLimits({ maxOutputTokens: 4_096, verified: true }),
    },
    {
      modelKey: 'gpt-4.1',
      displayName: 'OpenAI gpt-4.1(结构化输出)',
      capabilities: ['TEXT'],
      limits: textLimits({ maxOutputTokens: 8_192, verified: true }),
    },
  ];
}

/** 第三方 OpenAI 兼容网关:模型名由后台填写,能力必须逐个验证 */
export function describeOpenAiCompatibleTextModels(): ModelDescriptor[] {
  return [
    {
      modelKey: 'openai-compatible-default',
      displayName: 'OpenAI 兼容网关(模型名与结构化输出支持度待联调)',
      capabilities: ['TEXT'],
      limits: textLimits({ maxOutputTokens: 4_096, verified: false }),
    },
  ];
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export class OpenAiCompatibleTextProvider implements TextProvider {
  readonly kind: ProviderKind;

  private readonly providerLabel: string;
  private readonly strict: boolean;

  /**
   * @param kind 'OPENAI' 表示直连官方端点;'OPENAI_COMPATIBLE' 表示第三方兼容网关
   * @param strict 是否开启 json_schema.strict(需自行保证 schema 落在受支持子集内)
   */
  constructor(kind: Extract<ProviderKind, 'OPENAI' | 'OPENAI_COMPATIBLE'> = 'OPENAI', strict = false) {
    this.kind = kind;
    this.providerLabel = kind === 'OPENAI' ? 'OpenAI Chat' : 'OpenAI 兼容网关';
    this.strict = strict;
  }

  describeDefaultModels(): ModelDescriptor[] {
    return this.kind === 'OPENAI' ? describeOpenAiTextModels() : describeOpenAiCompatibleTextModels();
  }

  async generateStructured(
    req: StructuredTextRequest,
    creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<StructuredTextOutcome> {
    const phase: CallPhase = 'submit';
    const baseUrl = trimTrailingSlash(creds.baseUrl || OPENAI_DEFAULT_BASE_URL);

    const outcome = await httpCall({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      json: buildChatCompletionBody(req, this.strict),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!outcome.ok) {
      return classifyTransportFailure(phase, this.providerLabel, outcome.transport);
    }

    const { response, durationMs } = outcome;
    if (response.status < 200 || response.status >= 300) {
      const { detail, structured } = extractOpenAiError(response.json ?? response.bodyText);
      return classifyHttpFailure({
        phase,
        providerLabel: this.providerLabel,
        response,
        upstreamDetail: detail,
        hasStructuredError: structured,
      });
    }

    const parsed = parseChatCompletionResponse(response.json);
    if ('error' in parsed) {
      return malformedResponse(this.providerLabel, parsed.error, response.status);
    }
    if (parsed.refusal) {
      return {
        kind: 'failed',
        errorCode: ERROR_CODES.CONTENT_BLOCKED_OUTPUT,
        message: `[${this.providerLabel}] 模型拒绝生成:${sanitizeUpstreamMessage(parsed.refusal)}`,
        retryable: false,
        httpStatus: response.status,
      };
    }

    return finalizeStructuredText(this.providerLabel, parsed.raw, parsed.finishReason, durationMs, response.status);
  }

  async testConnection(creds: ProviderCredentials, options?: ProviderCallOptions): Promise<ConnectionTestResult> {
    const baseUrl = trimTrailingSlash(creds.baseUrl || OPENAI_DEFAULT_BASE_URL);
    const outcome = await httpCall({
      url: `${baseUrl}/models`,
      method: 'GET',
      headers: { authorization: `Bearer ${creds.apiKey}`, accept: 'application/json' },
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
      message: ok ? '连接正常' : sanitizeUpstreamMessage(extractOpenAiError(outcome.response.json).detail),
      httpStatus: outcome.response.status,
      latencyMs: outcome.durationMs,
      ...(ok ? {} : { errorCode: ERROR_CODES.UPSTREAM_ERROR }),
    };
  }
}

/**
 * 把原始字符串收敛成 StructuredTextOutcome。
 *
 * 只做「是不是合法 JSON」这一层判断:
 *  - 不是合法 JSON → CONTENT_STRUCTURE_INVALID,可重试(换一次采样常能修好);
 *  - 是合法 JSON → 原样返回 raw + parsed,业务结构校验交给上层的 zod。
 * 适配器绝不替上层做业务字段判断,也绝不「自动补字段」。
 */
export function finalizeStructuredText(
  providerLabel: string,
  raw: string,
  finishReason: string | undefined,
  upstreamDurationMs: number,
  httpStatus?: number,
): StructuredTextOutcome {
  // 被 max_completion_tokens 截断时 JSON 一定不完整,单独给出可读原因
  if (finishReason === 'length') {
    return {
      kind: 'failed',
      errorCode: ERROR_CODES.CONTENT_STRUCTURE_INVALID,
      message: `[${providerLabel}] 输出被 token 上限截断,JSON 不完整,请调高 maxOutputTokens 后重试`,
      retryable: true,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      kind: 'failed',
      errorCode: ERROR_CODES.CONTENT_STRUCTURE_INVALID,
      message: `[${providerLabel}] 上游返回的内容不是合法 JSON:${sanitizeUpstreamMessage(err)}`,
      retryable: true,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  }

  return {
    kind: 'completed',
    raw,
    parsed,
    upstreamDurationMs,
    ...(finishReason ? { finishReason } : {}),
  };
}
