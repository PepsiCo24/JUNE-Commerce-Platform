/**
 * 上游错误信息脱敏。
 *
 * 所有适配器在把上游文案带回上层之前,必须经过 sanitizeUpstreamMessage。
 * 需要防住的泄漏渠道:
 *  - 上游把我们发过去的请求体原样回显(常见于 400 / 422 参数校验错误),里面可能含参考图 base64;
 *  - 上游错误文案里带上了我们的 Authorization / x-key 头;
 *  - 上游返回带签名的临时链接(OSS / TOS / delivery.*.bfl.ai),query 里含 Signature / Expires;
 *  - 我们自己拼接错误文案时不小心把凭据带进去。
 */

/** 错误文案最大长度。超出直接截断,避免把整个请求体写进日志 */
export const MAX_MESSAGE_CHARS = 400;

const REDACTED = '[已脱敏]';

/**
 * 需要整体抹掉的敏感片段。
 * 顺序有意义:先抹长的结构化片段(data URI、base64 块),再抹具体的 key 形态。
 */
const REDACTION_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  // data URI(参考图会以 data:image/png;base64,... 形式出现在 Ark 请求体里)
  { pattern: /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, replacement: `data:[base64 ${REDACTED}]` },
  // Authorization / x-key / api-key 等请求头形态。
  // 上游回显请求头时既可能是裸文本(x-key: abc),也可能是 JSON("x-key":"abc"),
  // 所以名字两侧的引号都要容忍。
  {
    // 值一直吃到引号 / 逗号 / 右花括号 / 行尾:必须能覆盖 "Bearer xxx" 这种带空格的整体
    pattern: /("|')?(authorization|x-goog-api-key|x-key|x-dashscope-api-key|api[-_]?key)("|')?\s*[:=]\s*("|')?[^"',}\r\n]+/gi,
    replacement: `$2: ${REDACTED}`,
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, replacement: `Bearer ${REDACTED}` },
  // 常见供应商 key 前缀:OpenAI sk-/sess-、阿里云百炼 sk-、Google AIza
  { pattern: /\bsk-[A-Za-z0-9._-]{8,}/g, replacement: REDACTED },
  { pattern: /\bsess-[A-Za-z0-9._-]{8,}/g, replacement: REDACTED },
  { pattern: /\bAIza[A-Za-z0-9_-]{10,}/g, replacement: REDACTED },
  // JWT 形态(部分自建 OpenAI 兼容网关用 JWT 做鉴权)
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: REDACTED },
];

/** 带签名的临时链接:保留 host + path 便于排查,抹掉整个 query */
const SIGNED_URL_PATTERN = /(https?:\/\/[^\s"'<>]+?)\?[^\s"'<>]*/gi;

/** 裸 base64 长块(上游回显参考图但没带 data URI 前缀时) */
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{200,}={0,2}/g;

/**
 * 脱敏并截断上游文案。
 *
 * @param raw 上游返回的任意文本 / 已 JSON.stringify 的错误对象
 * @param maxChars 截断长度,默认 MAX_MESSAGE_CHARS
 */
export function sanitizeUpstreamMessage(raw: unknown, maxChars: number = MAX_MESSAGE_CHARS): string {
  let text = toPlainText(raw);
  if (text.length === 0) {
    return '上游未返回可读的错误信息';
  }

  for (const { pattern, replacement } of REDACTION_RULES) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(SIGNED_URL_PATTERN, `$1?${REDACTED}`);
  text = text.replace(LONG_BASE64_PATTERN, REDACTED);

  // 折叠空白,避免多行 JSON 撑爆日志行
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}…(已截断)`;
  }
  return text;
}

function toPlainText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/**
 * 构造「供应商 + 状态码 + 上游文案」的统一错误文案。
 * 供应商名与状态码是自己产生的,不需要脱敏;上游文案一律走 sanitizeUpstreamMessage。
 */
export function formatUpstreamMessage(
  providerLabel: string,
  httpStatus: number | undefined,
  upstreamDetail: unknown,
): string {
  const statusPart = httpStatus === undefined ? '' : ` HTTP ${httpStatus}`;
  return `[${providerLabel}${statusPart}] ${sanitizeUpstreamMessage(upstreamDetail)}`;
}
