/**
 * 前后端共享的纯函数工具。不含任何 IO,便于单元测试。
 */

import { HOT_SCORE_WEIGHTS, POST_EXCERPT_MAX } from './constants';

/**
 * 计算帖子热门分数。规则与 HOT_SCORE_WEIGHTS 注释一致,
 * 前端展示"热门规则说明"与后端定时重算共用此函数,保证口径一致。
 */
export function computeHotScore(input: {
  likeCount: number;
  commentCount: number;
  viewCount: number;
  publishedAt: Date | string | null;
  now?: Date;
}): number {
  const { like, comment, view, viewCap, gravity, timeOffsetHours } = HOT_SCORE_WEIGHTS;
  if (!input.publishedAt) return 0;

  const publishedAt = typeof input.publishedAt === 'string' ? new Date(input.publishedAt) : input.publishedAt;
  const now = input.now ?? new Date();
  const hours = Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);

  const score =
    input.likeCount * like + input.commentCount * comment + Math.min(input.viewCount, viewCap) * view + 1;

  return score / Math.pow(hours + timeOffsetHours, gravity);
}

/** 从 HTML 提取纯文本摘要。清洗后的 HTML 才可传入。 */
export function htmlToExcerpt(html: string, maxLength = POST_EXCERPT_MAX): string {
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

/**
 * 生成帖子 slug:可读前缀 + 短随机后缀。
 * 发布时生成一次并固定,之后编辑标题不改变公开链接。
 */
export function buildPostSlug(title: string, randomSuffix: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base ? `${base}-${randomSuffix}` : randomSuffix;
}

/** 字节数格式化,用于存储用量展示 */
export function formatBytes(bytes: number | bigint | string, fractionDigits = 1): string {
  const value = typeof bytes === 'bigint' ? Number(bytes) : typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / Math.pow(1024, exponent);
  return `${scaled.toFixed(exponent === 0 ? 0 : fractionDigits)} ${units[exponent]}`;
}

/** 密码/密钥脱敏展示。保留前 3 后 4,其余固定长度掩码,不反映真实长度。 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 3)}****${secret.slice(-4)}`;
}

/** 固定长度的密码掩码,不泄漏真实长度 */
export const PASSWORD_DISPLAY_MASK = '••••••••';

/**
 * 结果区网格列数。按需求:单张大图、两张双列、三至四张合理网格、更多自动网格。
 */
export function resultGridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

/** 判断 MIME 是否为图片 */
export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** 简单的游标编解码(不加密,仅避免前端拼装内部字段) */
export function encodeCursor(payload: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, string | number>>(cursor: string): T | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** 睡眠(退避重试用) */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 指数退避 + 抖动。用于 429 与上游临时错误的重试间隔计算。
 */
export function backoffDelayMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = exponential * 0.25 * Math.random();
  return Math.round(exponential - exponential * 0.125 + jitter);
}
