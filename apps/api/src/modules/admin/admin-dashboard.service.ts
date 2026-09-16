import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@june/db';
import type { DashboardMetrics } from '@june/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import {
  bucketKey,
  buildBuckets,
  fillSeries,
  MAX_RANGE_DAYS,
  resolveRange,
  successRate,
  SUCCESS_RATE_DEFINITION,
  toBigIntString,
  toNumber,
  type Granularity,
  type ResolvedRange,
} from './admin-stats.util';
import type { AdminDashboardView, TrendPoint } from './admin.types';

export interface DashboardQueryInput {
  from?: string;
  to?: string;
  granularity?: Granularity;
}

interface TotalsRow {
  users_total: unknown;
  users_new: unknown;
  users_active: unknown;
  shops_total: unknown;
  shops_main: unknown;
  shops_sub: unknown;
  products_total: unknown;
  posts_total: unknown;
  posts_published: unknown;
  posts_draft: unknown;
  posts_hidden: unknown;
  comments_total: unknown;
  tasks_total: unknown;
  tasks_succeeded: unknown;
  tasks_partial: unknown;
  tasks_failed: unknown;
  storage_bytes: unknown;
  storage_recycled: unknown;
}

/** 聚合异常时的降级零值,保证仪表盘不会整体不可用 */
const ZERO_TOTALS: TotalsRow = {
  users_total: 0,
  users_new: 0,
  users_active: 0,
  shops_total: 0,
  shops_main: 0,
  shops_sub: 0,
  products_total: 0,
  posts_total: 0,
  posts_published: 0,
  posts_draft: 0,
  posts_hidden: 0,
  comments_total: 0,
  tasks_total: 0,
  tasks_succeeded: 0,
  tasks_partial: 0,
  tasks_failed: 0,
  storage_bytes: '0',
  storage_recycled: '0',
};

interface BucketRow {
  bucket: string;
  value: unknown;
}

interface TaskBucketRow {
  bucket: string;
  total: unknown;
  succeeded: unknown;
  partial: unknown;
  failed: unknown;
}

/** 每个指标的统计口径。前端原样展示,避免"这个数到底怎么算的"这类争议。 */
const DEFINITIONS = {
  users: '未软删除(deletedAt IS NULL)的账号总数。全量口径,与所选区间无关',
  newUsers: '统计区间内 users.createdAt 落在区间内的账号数(按 UTC 自然日对齐,含首尾两天),不含已软删除账号',
  activeUsers:
    '统计区间内 Session.lastSeenAt 落在区间内的会话所属用户去重数。' +
    '同一用户多端登录只计一次;区间内完全没有发起请求的用户不计入。' +
    '注意 lastSeenAt 为节流更新(每会话最多 5 分钟写一次),因此是"活跃用户"的下界估计',
  shops: '未软删除的店铺总数,主店与子店合并计数(拆分见 breakdown.shopsMain / shopsSub)。全量口径',
  products: '未软删除的商品总数。全量口径,与区间无关',
  posts: '未软删除且状态不为 DELETED 的帖子总数(含草稿、已发布、已隐藏)。全量口径',
  comments: '未软删除且状态为 VISIBLE 的评论数;被隐藏或删除的评论不计入。全量口径',
  generationTasks: '统计区间内 GenerationTask.createdAt 落在区间内的任务数,含全部状态',
  storageBytes:
    'StorageUsage.bytesUsed 求和(字节,以字符串返回避免精度丢失)。只含已确认可用的资产,' +
    '不含回收站内待清理的 recycledBytes(见 breakdown.storageRecycledBytes)',
  shopsMain: '未软删除且 type = MAIN 的店铺数',
  shopsSub: '未软删除且 type = SUB 的店铺数(挂接在主店下的子店)',
  postsPublished: '未软删除且状态为 PUBLISHED 的帖子数',
  postsDraft: '未软删除且状态为 DRAFT 的帖子数(仅作者可见)',
  postsHidden: '未软删除且状态为 HIDDEN 的帖子数(被管理员隐藏)',
  generationSucceeded: '统计区间内状态为 SUCCEEDED 的任务数',
  generationPartial: '统计区间内状态为 PARTIAL(多图部分成功)的任务数',
  generationFailed: '统计区间内状态为 FAILED 的任务数',
  generationRateDenominator: '成功率分母:统计区间内 SUCCEEDED + PARTIAL + FAILED 的任务数',
  storageRecycledBytes: 'StorageUsage.recycledBytes 求和:已删除但仍在回收期、依然占用对象存储的字节数',
} as const;

const TREND_DEFINITIONS = {
  newUsers: '按桶统计 users.createdAt 落在该桶内的新增账号数(不含已软删除账号)',
  activeUsers: '按桶统计 Session.lastSeenAt 落在该桶内的去重用户数;跨桶的同一用户会在每个活跃桶各计一次',
  posts: '按桶统计 Post.createdAt 落在该桶内的新建帖子数(含草稿,不含已软删除)',
  tasks: '按桶统计 GenerationTask.createdAt 落在该桶内的任务数,并按终态拆出 succeeded / failed',
  successRate: `按桶计算的成功率(0~100)。${SUCCESS_RATE_DEFINITION}。该桶无可判定任务时为 0`,
  storageBytes: '按桶统计 Asset.confirmedAt 落在该桶内的资产 byteSize 之和,即该桶新增的存储占用(字节)',
} as const;

/**
 * 管理站仪表盘统计。
 *
 * 性能约定(目标环境 4 核 8G、约 50 人在线):
 *  1. **所有聚合都在 PostgreSQL 内完成**,用 `$queryRaw` + `date_trunc(...) GROUP BY 1`,
 *     Node 侧只做"稀疏桶补零"这类 O(桶数) 的工作,绝不把明细行拉到内存里 reduce。
 *  2. 参数一律走 `Prisma.sql` 模板标签(即 `$1/$2` 绑定参数),**没有任何字符串拼接 SQL**;
 *     SQL 里出现的字面量只有枚举名这类代码内常量,不来自请求。
 *  3. 结果整体缓存 60 秒,key 里带区间与粒度,避免多人同时刷仪表盘时重复聚合。
 *
 * 缓存边界(重要):
 *   缓存里**只有聚合后的数字与口径文案**,不含任何用户身份、角色或资源归属信息,
 *   也不按调用者区分 key —— 因为管理站仪表盘对所有管理员返回同一份全站统计。
 *   "谁能看这些数字"完全由 SessionGuard + RolesGuard 每请求回源数据库判定
 *   (`/api/admin/**` 无条件要求管理员等级),缓存命中与否都不会改变鉴权结果,
 *   因此不存在"靠过期缓存越权"的路径。权限判定与模型停用判定绝不读缓存。
 */
@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);

  /** 缓存版本前缀:结构变更时改版本号即可整体作废旧缓存 */
  private static readonly CACHE_PREFIX = 'admin:dashboard:v1:';
  private static readonly CACHE_TTL_SECONDS = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getDashboard(query: DashboardQueryInput): Promise<AdminDashboardView> {
    const range = resolveRange(query);
    const cacheKey = this.cacheKey(range);

    const cached = await this.redis.getJson<AdminDashboardView>(cacheKey);
    if (cached) return cached;

    const view = await this.compute(range);
    await this.redis.setJson(cacheKey, view, AdminDashboardService.CACHE_TTL_SECONDS);
    return view;
  }

  /** 强制失效统计缓存。只影响统计展示,不涉及任何鉴权状态。 */
  async refresh(): Promise<{ invalidatedKeys: number; refreshedAt: string }> {
    const invalidatedKeys = await this.redis.delByPrefix(AdminDashboardService.CACHE_PREFIX);
    this.logger.log(`仪表盘统计缓存已失效,清理 ${invalidatedKeys} 个 key`);
    return { invalidatedKeys, refreshedAt: new Date().toISOString() };
  }

  private cacheKey(range: ResolvedRange): string {
    return (
      `${AdminDashboardService.CACHE_PREFIX}` +
      `${bucketKey(range.from, 'day')}_${bucketKey(new Date(range.toExclusive.getTime() - 1), 'day')}` +
      `_${range.granularity}`
    );
  }

  // ---------------------------------------------------------------------------
  // 聚合
  // ---------------------------------------------------------------------------

  private async compute(range: ResolvedRange): Promise<AdminDashboardView> {
    const buckets = buildBuckets(range);

    // 6 次聚合查询(总量 1 次 + 趋势 5 次),都在库内完成。
    const [totals, newUsers, activeUsers, posts, tasks, storage] = await Promise.all([
      this.queryTotals(range),
      this.queryNewUsersTrend(range),
      this.queryActiveUsersTrend(range),
      this.queryPostsTrend(range),
      this.queryTasksTrend(range),
      this.queryStorageTrend(range),
    ]);

    const succeeded = toNumber(totals.tasks_succeeded);
    const partial = toNumber(totals.tasks_partial);
    const failed = toNumber(totals.tasks_failed);

    const taskSeries = new Map(tasks.map((row) => [row.bucket, row]));
    const tasksTrend = buckets.map((date) => {
      const row = taskSeries.get(date);
      return {
        date,
        succeeded: toNumber(row?.succeeded),
        failed: toNumber(row?.failed),
        total: toNumber(row?.total),
      };
    });
    const successRateTrend: TrendPoint[] = buckets.map((date) => {
      const row = taskSeries.get(date);
      return {
        date,
        value: successRate(toNumber(row?.succeeded), toNumber(row?.partial), toNumber(row?.failed)),
      };
    });

    const metrics: DashboardMetrics = {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        granularity: range.granularity,
      },
      totals: {
        users: { value: toNumber(totals.users_total), definition: DEFINITIONS.users },
        newUsers: { value: toNumber(totals.users_new), definition: DEFINITIONS.newUsers },
        activeUsers: { value: toNumber(totals.users_active), definition: DEFINITIONS.activeUsers },
        shops: { value: toNumber(totals.shops_total), definition: DEFINITIONS.shops },
        products: { value: toNumber(totals.products_total), definition: DEFINITIONS.products },
        posts: { value: toNumber(totals.posts_total), definition: DEFINITIONS.posts },
        comments: { value: toNumber(totals.comments_total), definition: DEFINITIONS.comments },
        generationTasks: {
          value: toNumber(totals.tasks_total),
          definition: DEFINITIONS.generationTasks,
        },
        generationSuccessRate: {
          value: successRate(succeeded, partial, failed),
          definition: SUCCESS_RATE_DEFINITION,
        },
        storageBytes: {
          value: toBigIntString(totals.storage_bytes),
          definition: DEFINITIONS.storageBytes,
        },
      },
      trends: {
        newUsers: fillSeries(buckets, newUsers),
        activeUsers: fillSeries(buckets, activeUsers),
        posts: fillSeries(buckets, posts),
        tasks: tasksTrend,
      },
      computedAt: new Date().toISOString(),
      cacheTtlSeconds: AdminDashboardService.CACHE_TTL_SECONDS,
    };

    return {
      ...metrics,
      breakdown: {
        shopsMain: { value: toNumber(totals.shops_main), definition: DEFINITIONS.shopsMain },
        shopsSub: { value: toNumber(totals.shops_sub), definition: DEFINITIONS.shopsSub },
        postsPublished: {
          value: toNumber(totals.posts_published),
          definition: DEFINITIONS.postsPublished,
        },
        postsDraft: { value: toNumber(totals.posts_draft), definition: DEFINITIONS.postsDraft },
        postsHidden: { value: toNumber(totals.posts_hidden), definition: DEFINITIONS.postsHidden },
        generationSucceeded: { value: succeeded, definition: DEFINITIONS.generationSucceeded },
        generationPartial: { value: partial, definition: DEFINITIONS.generationPartial },
        generationFailed: { value: failed, definition: DEFINITIONS.generationFailed },
        generationRateDenominator: {
          value: succeeded + partial + failed,
          definition: DEFINITIONS.generationRateDenominator,
        },
        storageRecycledBytes: {
          value: toBigIntString(totals.storage_recycled),
          definition: DEFINITIONS.storageRecycledBytes,
        },
      },
      extraTrends: {
        successRate: successRateTrend,
        storageBytes: fillSeries(buckets, storage),
      },
      trendDefinitions: { ...TREND_DEFINITIONS },
    };
  }

  /**
   * 总量与区间内任务分布,一次往返完成。
   * 每个子查询都能命中既有索引(users.createdAt、posts(status,...)、
   * sessions.lastSeenAt 走 (userId, scope) 之外的时间过滤由 seq scan + filter 完成,
   * 数据量级在本平台可接受),没有把明细取回 Node 的路径。
   */
  private async queryTotals(range: ResolvedRange): Promise<TotalsRow> {
    const rows = await this.prisma.db.$queryRaw<TotalsRow[]>(Prisma.sql`
      WITH task_stats AS (
        SELECT
          (count(*))::int AS total,
          (count(*) FILTER (WHERE status = 'SUCCEEDED'))::int AS succeeded,
          (count(*) FILTER (WHERE status = 'PARTIAL'))::int AS partial,
          (count(*) FILTER (WHERE status = 'FAILED'))::int AS failed
        FROM generation_tasks
        WHERE "createdAt" >= ${range.from} AND "createdAt" < ${range.toExclusive}
      )
      SELECT
        (SELECT (count(*))::int FROM users WHERE "deletedAt" IS NULL) AS users_total,
        (SELECT (count(*))::int FROM users
           WHERE "deletedAt" IS NULL
             AND "createdAt" >= ${range.from} AND "createdAt" < ${range.toExclusive}) AS users_new,
        (SELECT (count(DISTINCT s."userId"))::int
           FROM sessions s
           JOIN users u ON u.id = s."userId" AND u."deletedAt" IS NULL
          WHERE s."lastSeenAt" >= ${range.from} AND s."lastSeenAt" < ${range.toExclusive}) AS users_active,
        (SELECT (count(*))::int FROM shops WHERE "deletedAt" IS NULL) AS shops_total,
        (SELECT (count(*))::int FROM shops WHERE "deletedAt" IS NULL AND type = 'MAIN') AS shops_main,
        (SELECT (count(*))::int FROM shops WHERE "deletedAt" IS NULL AND type = 'SUB') AS shops_sub,
        (SELECT (count(*))::int FROM products WHERE "deletedAt" IS NULL) AS products_total,
        (SELECT (count(*))::int FROM posts
           WHERE "deletedAt" IS NULL AND status <> 'DELETED') AS posts_total,
        (SELECT (count(*))::int FROM posts
           WHERE "deletedAt" IS NULL AND status = 'PUBLISHED') AS posts_published,
        (SELECT (count(*))::int FROM posts
           WHERE "deletedAt" IS NULL AND status = 'DRAFT') AS posts_draft,
        (SELECT (count(*))::int FROM posts
           WHERE "deletedAt" IS NULL AND status = 'HIDDEN') AS posts_hidden,
        (SELECT (count(*))::int FROM comments
           WHERE "deletedAt" IS NULL AND status = 'VISIBLE') AS comments_total,
        t.total AS tasks_total,
        t.succeeded AS tasks_succeeded,
        t.partial AS tasks_partial,
        t.failed AS tasks_failed,
        (SELECT (COALESCE(sum("bytesUsed"), 0))::text FROM storage_usage) AS storage_bytes,
        (SELECT (COALESCE(sum("recycledBytes"), 0))::text FROM storage_usage) AS storage_recycled
      FROM task_stats t
    `);

    const row = rows[0];
    if (!row) {
      // CTE 恒返回一行,理论上不会走到这里;兜底给全零,避免仪表盘因统计异常整体不可用
      this.logger.warn('仪表盘总量聚合返回空结果,已按零值降级');
      return ZERO_TOTALS;
    }
    return row;
  }

  private async queryNewUsersTrend(range: ResolvedRange): Promise<BucketRow[]> {
    return this.prisma.db.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT
        to_char(date_trunc(${range.granularity}::text, "createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
        (count(*))::int AS value
      FROM users
      WHERE "deletedAt" IS NULL
        AND "createdAt" >= ${range.from} AND "createdAt" < ${range.toExclusive}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  private async queryActiveUsersTrend(range: ResolvedRange): Promise<BucketRow[]> {
    return this.prisma.db.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT
        to_char(date_trunc(${range.granularity}::text, s."lastSeenAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
        (count(DISTINCT s."userId"))::int AS value
      FROM sessions s
      JOIN users u ON u.id = s."userId" AND u."deletedAt" IS NULL
      WHERE s."lastSeenAt" >= ${range.from} AND s."lastSeenAt" < ${range.toExclusive}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  private async queryPostsTrend(range: ResolvedRange): Promise<BucketRow[]> {
    return this.prisma.db.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT
        to_char(date_trunc(${range.granularity}::text, "createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
        (count(*))::int AS value
      FROM posts
      WHERE "deletedAt" IS NULL
        AND "createdAt" >= ${range.from} AND "createdAt" < ${range.toExclusive}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  private async queryTasksTrend(range: ResolvedRange): Promise<TaskBucketRow[]> {
    return this.prisma.db.$queryRaw<TaskBucketRow[]>(Prisma.sql`
      SELECT
        to_char(date_trunc(${range.granularity}::text, "createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
        (count(*))::int AS total,
        (count(*) FILTER (WHERE status = 'SUCCEEDED'))::int AS succeeded,
        (count(*) FILTER (WHERE status = 'PARTIAL'))::int AS partial,
        (count(*) FILTER (WHERE status = 'FAILED'))::int AS failed
      FROM generation_tasks
      WHERE "createdAt" >= ${range.from} AND "createdAt" < ${range.toExclusive}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  private async queryStorageTrend(range: ResolvedRange): Promise<BucketRow[]> {
    return this.prisma.db.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT
        to_char(date_trunc(${range.granularity}::text, "confirmedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
        (COALESCE(sum("byteSize"), 0))::text AS value
      FROM assets
      WHERE "confirmedAt" IS NOT NULL
        AND "confirmedAt" >= ${range.from} AND "confirmedAt" < ${range.toExclusive}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  /** 供接口回显:当前允许的最大区间天数 */
  static get maxRangeDays(): number {
    return MAX_RANGE_DAYS;
  }
}
