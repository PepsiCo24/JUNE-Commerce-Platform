/**
 * 社区模块内部共用的纯函数:公开链接拼装与游标编解码。
 */
import { decodeCursor, encodeCursor, ERROR_CODES } from '@june/shared';

import { AppException } from '../../common/errors/app-exception';

/** 帖子公开链接。slug 发布时固定,之后改标题也不会变。 */
export function buildPostPublicUrl(webOrigin: string, slug: string): string {
  return `${webOrigin.replace(/\/+$/, '')}/community/posts/${encodeURIComponent(slug)}`;
}

/** 时间 + id 组成的游标载荷。id 用于打破同一毫秒内的并列。 */
export interface TimeCursor extends Record<string, string | number> {
  t: number;
  id: string;
}

/** 热门排序游标:分数 + 时间 + id */
export interface HotCursor extends Record<string, string | number> {
  s: number;
  t: number;
  id: string;
}

export function encodeTimeCursor(at: Date, id: string): string {
  return encodeCursor({ t: at.getTime(), id });
}

export function encodeHotCursor(score: number, at: Date, id: string): string {
  return encodeCursor({ s: score, t: at.getTime(), id });
}

/**
 * 解析游标。非法游标直接报错而不是静默回到第一页,
 * 否则前端会在"翻页失败"时无声地重复展示首屏内容。
 */
export function parseCursor<T extends Record<string, string | number>>(
  cursor: string,
  requiredKeys: Array<keyof T>,
): T {
  const payload = decodeCursor<T>(cursor);
  const valid =
    payload !== null &&
    typeof payload === 'object' &&
    requiredKeys.every((key) => payload[key] !== undefined && payload[key] !== null);

  if (!valid) {
    throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '分页游标无效,请重新加载列表');
  }
  return payload;
}
