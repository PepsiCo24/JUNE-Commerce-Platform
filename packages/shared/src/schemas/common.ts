import { z } from 'zod';

import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants';

/** cuid/cuid2 形态的 ID。统一用长度与字符集约束,避免误收任意字符串 */
export const idSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/, 'ID 格式不正确');

export const idListSchema = z.array(idSchema).max(200);

/** 页码分页(小列表:店铺、模型配置等) */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** 游标分页(大列表:帖子大厅、商品、任务历史、审计日志) */
export const cursorQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
});

/** 日期区间筛选(管理站统计) */
export const dateRangeSchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), {
    message: '开始时间不能晚于结束时间',
    path: ['from'],
  });

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CursorResult<T> {
  items: T[];
  /** 下一页游标。为 null 表示没有更多数据 */
  nextCursor: string | null;
  hasMore: boolean;
}

/** 统计口径说明。所有仪表盘数字都必须附带口径,避免歧义。 */
export interface MetricWithDefinition {
  value: number;
  /** 口径说明,如"统计区间内 createdAt 落在区间的用户数" */
  definition: string;
  /** 数据是否来自缓存,以及缓存时间 */
  cachedAt?: string | null;
}
