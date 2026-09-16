/**
 * 任务参数与错误信息脱敏。
 *
 * 沿用 `AuditService.redact` 的思路(字段名黑名单 + 递归 + 截断),
 * 但任务详情面向管理员展示,还需要额外处理**值里**夹带的密钥:
 * 上游错误信息经常把 `Authorization: Bearer sk-xxx` 或 `?key=xxx` 原样回吐,
 * 这类内容不能出现在管理站界面或日志里。
 *
 * 这里是纯函数,不依赖 Nest 容器,便于单测直接调用。
 */

/** 绝不允许展示的字段名 */
const FORBIDDEN_FIELDS =
  /password|passwd|secret|apikey|api_key|access_key|token|credential|authorization|cookie|cipher|privatekey|signature/i;

const REDACTED = '[redacted]';

/** 值内密钥形态:各家 API Key 前缀、Bearer 令牌、查询串里的 key/token 参数 */
const VALUE_PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /\b(sk|pk|rk|ak|api|key)[-_][A-Za-z0-9_-]{12,}/gi, replace: REDACTED },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: `Bearer ${REDACTED}` },
  {
    pattern: /\b(api[-_]?key|access[-_]?key|secret|token|signature|sign)\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: `$1=${REDACTED}`,
  },
  // 阿里云/火山常见的 AccessKeyId 形态
  { pattern: /\bLTAI[A-Za-z0-9]{8,}/g, replace: REDACTED },
  { pattern: /\bAKIA[A-Z0-9]{12,}/g, replace: REDACTED },
];

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 1000;

function scrubString(input: string): string {
  let out = input;
  for (const { pattern, replace } of VALUE_PATTERNS) {
    out = out.replace(pattern, replace);
  }
  if (out.length > MAX_STRING_LENGTH) {
    out = `${out.slice(0, MAX_STRING_LENGTH)}…(已截断)`;
  }
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[deep]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    return redactObject(value as Record<string, unknown>, depth + 1);
  }
  // 函数、symbol 等非序列化值不该出现在任务参数里,统一丢弃
  return null;
}

function redactObject(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = FORBIDDEN_FIELDS.test(key) ? REDACTED : redactValue(value, depth);
  }
  return out;
}

/**
 * 脱敏任务的 `input`(即前端所称的"生成参数")。
 * 正常情况下 `GenerationTask.input` 本身就不含密钥,这里是最后一道防线。
 */
export function redactTaskParams(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { value: redactValue(input, 1) };
  }
  return redactObject(input as Record<string, unknown>, 1);
}

/** 脱敏上游错误信息。null 原样返回,便于前端区分"没有错误"与"错误信息为空串"。 */
export function redactErrorMessage(message: string | null | undefined): string | null {
  if (message === null || message === undefined) return null;
  return scrubString(message);
}
