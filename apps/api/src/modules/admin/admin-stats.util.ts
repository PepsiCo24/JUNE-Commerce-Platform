/**
 * 管理站统计的纯函数工具:区间解析、时间分桶、聚合结果类型归一。
 *
 * 这里不做任何 IO,便于单元测试;所有 SQL 都在各 service 中用
 * `Prisma.sql` 模板参数化拼装,本文件只负责把结果对齐到前端需要的桶序列。
 */
import { ERROR_CODES } from '@june/shared';

import { AppException } from '../../common/errors/app-exception';
import type { TrendPoint } from './admin.types';

export type Granularity = 'day' | 'week';

const DAY_MS = 86_400_000;

/** 趋势区间上限。超过后单次聚合的扫描量与响应体都会失控。 */
export const MAX_RANGE_DAYS = 90;
/** 未指定区间时的默认窗口 */
export const DEFAULT_RANGE_DAYS = 30;

export interface ResolvedRange {
  /** 区间起点(UTC 当日 00:00:00) */
  from: Date;
  /** 区间终点(UTC 当日 23:59:59.999),仅用于回显 */
  to: Date;
  /** 半开区间右端点(UTC 次日 00:00:00),SQL 里统一用 `>= from AND < toExclusive` */
  toExclusive: Date;
  /** 自然天数(含首尾) */
  days: number;
  granularity: Granularity;
}

function startOfUtcDay(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

/** UTC 周一为一周起点,与 PostgreSQL `date_trunc('week', ...)` 一致 */
function startOfUtcWeek(input: Date): Date {
  const day = startOfUtcDay(input);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
}

/**
 * 解析统计区间。
 *
 * 口径:左右都按 UTC 自然日对齐,区间含首尾两天。
 * 超过 90 天直接拒绝,而不是悄悄截断——统计口径必须可预期。
 */
export function resolveRange(
  input: { from?: string; to?: string; granularity?: Granularity },
  now: Date = new Date(),
): ResolvedRange {
  const granularity: Granularity = input.granularity ?? 'day';

  const toDay = startOfUtcDay(input.to ? new Date(input.to) : now);
  const fromDay = startOfUtcDay(
    input.from ? new Date(input.from) : new Date(toDay.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS),
  );

  if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime())) {
    throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '统计区间的日期格式不正确');
  }
  if (fromDay.getTime() > toDay.getTime()) {
    throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '开始时间不能晚于结束时间');
  }

  const days = Math.round((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw AppException.badRequest(
      ERROR_CODES.VALIDATION_FAILED,
      `统计区间最长 ${MAX_RANGE_DAYS} 天,当前为 ${days} 天`,
    );
  }

  const toExclusive = new Date(toDay.getTime() + DAY_MS);
  return {
    from: fromDay,
    to: new Date(toExclusive.getTime() - 1),
    toExclusive,
    days,
    granularity,
  };
}

/** 桶键统一为 `YYYY-MM-DD`(周粒度取该周周一),与 SQL 的 to_char 输出一致 */
export function bucketKey(input: Date, granularity: Granularity): string {
  const aligned = granularity === 'week' ? startOfUtcWeek(input) : startOfUtcDay(input);
  return aligned.toISOString().slice(0, 10);
}

/**
 * 生成完整桶序列。
 * SQL 的 GROUP BY 只会返回有数据的桶,前端图表需要"零值也占位",因此由这里补齐。
 */
export function buildBuckets(range: ResolvedRange): string[] {
  const step = range.granularity === 'week' ? 7 * DAY_MS : DAY_MS;
  const start =
    range.granularity === 'week' ? startOfUtcWeek(range.from) : startOfUtcDay(range.from);

  const keys: string[] = [];
  for (let t = start.getTime(); t < range.toExclusive.getTime(); t += step) {
    keys.push(new Date(t).toISOString().slice(0, 10));
    // 兜底:桶数不可能超过 90 个(周粒度更少),防御性上限避免死循环
    if (keys.length > MAX_RANGE_DAYS) break;
  }
  return keys;
}

/** pg 驱动可能把聚合值返回为 number / bigint / string(int8),统一归一到 number */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** BigInt(字节数)一律以字符串返回前端,避免精度丢失 */
export function toBigIntString(value: unknown): string {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.round(value).toString();
  const text = String(value).trim();
  return /^-?\d+$/.test(text) ? text : String(Math.round(Number(text) || 0));
}

/** 把 SQL 返回的稀疏桶对齐到完整桶序列 */
export function fillSeries(
  buckets: string[],
  rows: Array<{ bucket: string; value: unknown }>,
): TrendPoint[] {
  const byBucket = new Map(rows.map((r) => [r.bucket, toNumber(r.value)]));
  return buckets.map((date) => ({ date, value: byBucket.get(date) ?? 0 }));
}

/**
 * 成功率口径(全平台唯一实现,仪表盘与任务统计共用):
 *   成功率 = SUCCEEDED / (SUCCEEDED + PARTIAL + FAILED)
 * 分母**不含** QUEUED / RUNNING / CANCELED / TIMEOUT / UNKNOWN:
 *  - QUEUED / RUNNING 尚未出结果,计入会让成功率随排队长度波动;
 *  - CANCELED 是用户主动放弃,不代表平台失败;
 *  - TIMEOUT / UNKNOWN 结果未知,核对完成后会转为终态再计入,避免误判上游成败。
 * PARTIAL(多图任务部分成功)计入分母但不计入分子。
 */
export function successRate(succeeded: number, partial: number, failed: number): number {
  const denominator = succeeded + partial + failed;
  if (denominator <= 0) return 0;
  return Math.round((succeeded / denominator) * 1000) / 10;
}

export const SUCCESS_RATE_DEFINITION =
  '成功率 = SUCCEEDED / (SUCCEEDED + PARTIAL + FAILED);分母只含可判定成败的终态任务,' +
  '不含 QUEUED、RUNNING、CANCELED、TIMEOUT、UNKNOWN;PARTIAL(部分成功)计入分母但不计入分子';
