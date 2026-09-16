/**
 * limits 构造助手。
 *
 * 一律通过 @june/shared 的 modelLimitsSchema.parse 生成,好处是:
 *  1. 默认值只有一份(在 shared 里),适配层不重复定义;
 *  2. 适配层填错字段名 / 越界取值时在构建期就报错,而不是运行时静默降级;
 *  3. 前端拿到的 limits 与后端校验用的 limits 结构完全一致。
 */

import { modelLimitsSchema, type ModelLimits } from '@june/shared';

export type ModelLimitsInput = Partial<ModelLimits>;

export function buildLimits(input: ModelLimitsInput): ModelLimits {
  return modelLimitsSchema.parse(input);
}

/** 把 "1024x1024" 拆成 { width, height };格式不合法返回 undefined */
export function parseSizeString(size: string | undefined): { width: number; height: number } | undefined {
  if (!size) return undefined;
  const match = /^(\d{2,5})[x*](\d{2,5})$/.exec(size.trim());
  if (!match) return undefined;
  const width = Number.parseInt(match[1] as string, 10);
  const height = Number.parseInt(match[2] as string, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return { width, height };
}

/** 把参考图字节安全转成 base64(不带 data URI 前缀) */
export function toBase64(data: Buffer | Uint8Array): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
}

/** 读取 extraParams 里的布尔值,缺失或类型不符时返回 fallback */
export function readBoolean(extra: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = extra[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 读取 extraParams 里的字符串,并限定在允许的取值集合内 */
export function readEnum<T extends string>(
  extra: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T | undefined,
): T | undefined {
  const value = extra[key];
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

/** 读取 extraParams 里的整数,并夹到 [min, max] */
export function readInt(
  extra: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number | undefined,
): number | undefined {
  const value = extra[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}
