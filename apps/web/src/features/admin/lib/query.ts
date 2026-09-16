import type { PageResult } from '@june/shared';

/** 把 URL 筛选转成 API query。空字符串不发送,避免覆盖后端默认值。 */
export function compactQuery(input: Record<string, string | number | boolean | undefined | null>): Record<
  string,
  string | number | boolean
> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    result[key] = value;
  }
  return result;
}

/** HTML date(YYYY-MM-DD) → 带偏移的 ISO。空值表示交给后端默认区间。 */
export function dateToIsoStart(date: string): string | undefined {
  if (!date) return undefined;
  return `${date}T00:00:00.000Z`;
}

export function dateToIsoEnd(date: string): string | undefined {
  if (!date) return undefined;
  return `${date}T23:59:59.999Z`;
}

export function emptyPage<T>(): PageResult<T> {
  return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };
}
