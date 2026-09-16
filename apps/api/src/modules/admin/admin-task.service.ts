import { Injectable } from '@nestjs/common';
import { Prisma, TaskStatus, TaskType } from '@june/db';
import { cursorQuerySchema, decodeCursor, encodeCursor, idSchema } from '@june/shared';
import { z } from 'zod';

import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { redactErrorMessage, redactTaskParams } from './admin-redact.util';
import { resolveRange, successRate, SUCCESS_RATE_DEFINITION, toNumber } from './admin-stats.util';
import type {
  AdminTaskDetailView,
  AdminTaskListItem,
  AdminTaskResultView,
  AdminTaskStatsResponse,
  AdminTaskStatsRow,
} from './admin.types';

/**
 * 管理站任务记录筛选条件。
 *
 * `@june/shared` 的 `taskListQuerySchema` 是给用户侧"我的任务"用的(只有 type/status),
 * 管理站还需要按用户、供应商、模型、时间筛选。契约里没有对应 schema 且不允许改契约,
 * 因此在管理站内部定义;字段命名与契约保持同一风格,前端引用本模块导出的类型。
 */
export const adminTaskListQuerySchema = cursorQuerySchema.extend({
  userId: idSchema.optional(),
  status: z.enum(['ALL', ...Object.values(TaskStatus)] as [string, ...string[]]).default('ALL'),
  type: z.enum(['ALL', ...Object.values(TaskType)] as [string, ...string[]]).default('ALL'),
  providerSlug: z.string().trim().max(80).optional(),
  modelConfigId: idSchema.optional(),
  /**
   * 只看有错误码的任务,便于排障。
   * 用字符串枚举而不是 z.coerce.boolean():后者会把 'false' 也转成 true。
   */
  onlyFailed: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type AdminTaskListQuery = z.infer<typeof adminTaskListQuerySchema>;

export const adminTaskStatsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  providerSlug: z.string().trim().max(80).optional(),
});
export type AdminTaskStatsQuery = z.infer<typeof adminTaskStatsQuerySchema>;

interface StatsRow {
  provider_slug: string | null;
  model_key: string | null;
  model_display_name: string | null;
  total: unknown;
  succeeded: unknown;
  partial: unknown;
  failed: unknown;
  provider_calls: unknown;
  p50_ms: unknown;
  p95_ms: unknown;
}

interface TaskCursor extends Record<string, string | number> {
  createdAt: string;
  id: string;
}

@Injectable()
export class AdminTaskService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // 列表
  // ---------------------------------------------------------------------------

  async list(query: AdminTaskListQuery): Promise<{
    items: AdminTaskListItem[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const rows = await this.prisma.db.generationTask.findMany({
      where: this.buildWhere(query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        stage: true,
        providerSlug: true,
        modelKey: true,
        modelDisplayName: true,
        configVersion: true,
        requestedCount: true,
        succeededCount: true,
        failedCount: true,
        providerCallCount: true,
        providerTaskIds: true,
        errorCode: true,
        errorMessage: true,
        retryable: true,
        attempt: true,
        queueWaitMs: true,
        upstreamDurationMs: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        user: { select: { email: true } },
      },
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map((row) => this.toListItem(row)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      hasMore: rows.length > query.limit,
    };
  }

  private buildWhere(query: AdminTaskListQuery): Prisma.GenerationTaskWhereInput {
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;

    return {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.status === 'ALL' ? {} : { status: query.status as TaskStatus }),
      ...(query.type === 'ALL' ? {} : { type: query.type as TaskType }),
      ...(query.providerSlug ? { providerSlug: query.providerSlug } : {}),
      ...(query.modelConfigId ? { modelConfigId: query.modelConfigId } : {}),
      ...(query.onlyFailed ? { errorCode: { not: null } } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
      ...this.cursorWhere(query.cursor),
    };
  }

  private cursorWhere(cursor?: string): Prisma.GenerationTaskWhereInput {
    if (!cursor) return {};
    const decoded = decodeCursor<TaskCursor>(cursor);
    if (!decoded?.createdAt || !decoded.id) return {};
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) return {};
    return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: decoded.id } }] };
  }

  private toListItem(row: {
    id: string;
    userId: string;
    type: string;
    status: string;
    stage: string;
    providerSlug: string | null;
    modelKey: string | null;
    modelDisplayName: string | null;
    configVersion: number;
    requestedCount: number;
    succeededCount: number;
    failedCount: number;
    providerCallCount: number;
    providerTaskIds: string[];
    errorCode: string | null;
    errorMessage: string | null;
    retryable: boolean;
    attempt: number;
    queueWaitMs: number | null;
    upstreamDurationMs: number | null;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    user?: { email: string } | null;
  }): AdminTaskListItem {
    return {
      id: row.id,
      userId: row.userId,
      userEmail: row.user?.email ?? null,
      type: row.type,
      status: row.status,
      stage: row.stage,
      providerSlug: row.providerSlug,
      modelKey: row.modelKey,
      modelDisplayName: row.modelDisplayName,
      configVersion: row.configVersion,
      requestedCount: row.requestedCount,
      succeededCount: row.succeededCount,
      failedCount: row.failedCount,
      providerCallCount: row.providerCallCount,
      providerTaskIds: row.providerTaskIds,
      errorCode: row.errorCode,
      // 上游错误信息可能夹带密钥,展示前必须脱敏
      errorMessage: redactErrorMessage(row.errorMessage),
      retryable: row.retryable,
      attempt: row.attempt,
      queueWaitMs: row.queueWaitMs,
      upstreamDurationMs: row.upstreamDurationMs,
      totalDurationMs: row.finishedAt
        ? row.finishedAt.getTime() - row.createdAt.getTime()
        : null,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // 详情
  // ---------------------------------------------------------------------------

  /**
   * 任务详情。
   * `params`(即 `GenerationTask.input`)与所有 `errorMessage` 都经 `redactTaskParams` /
   * `redactErrorMessage` 处理:字段名命中黑名单的直接替换,值里形似 API Key / Bearer 令牌的
   * 片段也会被替换。**管理站界面与日志都不会出现任何密钥。**
   */
  async detail(taskId: string): Promise<AdminTaskDetailView> {
    const task = await this.prisma.db.generationTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        stage: true,
        providerSlug: true,
        modelKey: true,
        modelDisplayName: true,
        configVersion: true,
        requestedCount: true,
        succeededCount: true,
        failedCount: true,
        providerCallCount: true,
        providerTaskIds: true,
        errorCode: true,
        errorMessage: true,
        retryable: true,
        attempt: true,
        queueWaitMs: true,
        upstreamDurationMs: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        input: true,
        referenceCount: true,
        user: { select: { email: true } },
        results: {
          orderBy: { seq: 'asc' },
          select: {
            id: true,
            seq: true,
            status: true,
            assetId: true,
            providerTaskId: true,
            errorCode: true,
            errorMessage: true,
            textPayload: true,
            checkResult: true,
            createdAt: true,
            finishedAt: true,
          },
        },
      },
    });
    if (!task) throw AppException.notFound('任务不存在');

    const results: AdminTaskResultView[] = task.results.map((result) => ({
      id: result.id,
      seq: result.seq,
      status: result.status,
      assetId: result.assetId,
      providerTaskId: result.providerTaskId,
      errorCode: result.errorCode,
      errorMessage: redactErrorMessage(result.errorMessage),
      // 文案正文属于用户内容,管理站列表不展开,只标记是否存在
      hasTextPayload: result.textPayload !== null && result.textPayload !== undefined,
      checkPassed: this.readCheckPassed(result.checkResult),
      createdAt: result.createdAt.toISOString(),
      finishedAt: result.finishedAt?.toISOString() ?? null,
    }));

    return {
      ...this.toListItem(task),
      params: redactTaskParams(task.input),
      referenceCount: task.referenceCount,
      results,
    };
  }

  private readCheckPassed(checkResult: unknown): boolean | null {
    if (!checkResult || typeof checkResult !== 'object' || Array.isArray(checkResult)) return null;
    const passed = (checkResult as Record<string, unknown>).passed;
    return typeof passed === 'boolean' ? passed : null;
  }

  // ---------------------------------------------------------------------------
  // 统计:按供应商/模型的成功率与 P95 耗时
  // ---------------------------------------------------------------------------

  /**
   * 成功率与耗时分位数统计。
   *
   * 全部在库内用 `percentile_cont` 聚合完成,不把耗时明细拉到 Node;
   * 参数通过 `Prisma.sql` 模板绑定(`$1/$2/...`),没有字符串拼接。
   */
  async stats(query: AdminTaskStatsQuery): Promise<AdminTaskStatsResponse> {
    const range = resolveRange({ from: query.from, to: query.to });

    const rows = await this.prisma.db.$queryRaw<StatsRow[]>(Prisma.sql`
      SELECT
        COALESCE("providerSlug", '(unknown)') AS provider_slug,
        COALESCE("modelKey", '(unknown)') AS model_key,
        max("modelDisplayName") AS model_display_name,
        (count(*))::int AS total,
        (count(*) FILTER (WHERE status = 'SUCCEEDED'))::int AS succeeded,
        (count(*) FILTER (WHERE status = 'PARTIAL'))::int AS partial,
        (count(*) FILTER (WHERE status = 'FAILED'))::int AS failed,
        (COALESCE(sum("providerCallCount"), 0))::int AS provider_calls,
        -- 显式转 float8:percentile_cont 只接受 double precision,
        -- 依赖隐式类型转换会让执行计划与函数解析变得不可预期
        (percentile_cont(0.5) WITHIN GROUP (
          ORDER BY ("upstreamDurationMs")::float8
        ))::int AS p50_ms,
        (percentile_cont(0.95) WITHIN GROUP (
          ORDER BY ("upstreamDurationMs")::float8
        ))::int AS p95_ms
      FROM generation_tasks
      WHERE "createdAt" >= ${range.from}
        AND "createdAt" < ${range.toExclusive}
        AND (${query.providerSlug ?? null}::text IS NULL OR "providerSlug" = ${query.providerSlug ?? null}::text)
      GROUP BY 1, 2
      ORDER BY total DESC
      LIMIT 200
    `);

    const mapped: AdminTaskStatsRow[] = rows.map((row) => {
      const succeeded = toNumber(row.succeeded);
      const partial = toNumber(row.partial);
      const failed = toNumber(row.failed);
      return {
        providerSlug: row.provider_slug ?? '(unknown)',
        modelKey: row.model_key ?? '(unknown)',
        modelDisplayName: row.model_display_name,
        total: toNumber(row.total),
        succeeded,
        partial,
        failed,
        rateDenominator: succeeded + partial + failed,
        successRate: successRate(succeeded, partial, failed),
        p50UpstreamMs: row.p50_ms === null || row.p50_ms === undefined ? null : toNumber(row.p50_ms),
        p95UpstreamMs: row.p95_ms === null || row.p95_ms === undefined ? null : toNumber(row.p95_ms),
        providerCallCount: toNumber(row.provider_calls),
      };
    });

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      rows: mapped,
      definitions: {
        successRate: SUCCESS_RATE_DEFINITION,
        p95: 'P95 上游耗时 = percentile_cont(0.95) over GenerationTask.upstreamDurationMs(仅统计已记录上游耗时的任务;排队等待 queueWaitMs 不计入)',
        providerCallCount:
          'providerCallCount 之和 = 实际发往上游的调用次数(计费口径);单个任务拆分多次调用或重试都会累加,因此可能大于任务数',
      },
      computedAt: new Date().toISOString(),
    };
  }
}
