import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@june/db';
import {
  cursorQuerySchema,
  decodeCursor,
  encodeCursor,
  ERROR_CODES,
  formatBytes,
  type CleanupRunView,
} from '@june/shared';
import { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { QueueProducerService } from '../queue/queue-producer.service';
import { toBigIntString, toNumber } from './admin-stats.util';
import type { ClientMeta } from './admin-user.service';
import type { AdminStorageOverviewView } from './admin.types';

/** 单用户配额硬上限:10 TB。防止误操作把配额设成天文数字导致磁盘被打满。 */
const QUOTA_HARD_MAX_BYTES = 10n * 1024n ** 4n;
/** 单用户配额下限:1 MB。低于此值连头像都传不了。 */
const QUOTA_MIN_BYTES = 1024n * 1024n;

export const storageOverviewQuerySchema = z.object({
  topN: z.coerce.number().int().min(1).max(50).default(10),
});
export type StorageOverviewQuery = z.infer<typeof storageOverviewQuerySchema>;

export const storageQuotaUpdateSchema = z.object({
  /** 字节数。BigInt 用字符串传递,避免 JSON number 精度问题 */
  quotaBytes: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/, '配额必须是以字节为单位的正整数字符串'),
  reason: z.string().trim().max(300).optional(),
});
export type StorageQuotaUpdateInput = z.infer<typeof storageQuotaUpdateSchema>;

export const cleanupRunListQuerySchema = cursorQuerySchema.extend({
  kind: z.enum(['ALL', 'orphan_asset', 'expired_upload', 'recycled_asset', 'queue_record']).default('ALL'),
});
export type CleanupRunListQuery = z.infer<typeof cleanupRunListQuerySchema>;

export interface CleanupTriggerInput {
  kind: 'orphan_asset' | 'expired_upload' | 'recycled_asset' | 'queue_record';
  dryRun: boolean;
  limit: number;
}

/** 管理站清理类型 -> 队列维护任务类型。两侧命名不同,映射集中在这里。 */
const MAINTENANCE_KIND = {
  orphan_asset: 'cleanup_orphan_asset',
  expired_upload: 'cleanup_expired_upload',
  recycled_asset: 'purge_recycled_asset',
  queue_record: 'prune_queue_records',
} as const;

interface AssetTotalsRow {
  active_bytes: unknown;
  active_count: unknown;
  recycled_bytes: unknown;
  recycled_count: unknown;
  orphan_bytes: unknown;
  due_bytes: unknown;
  due_count: unknown;
}

interface TopUserRow {
  user_id: string;
  email: string;
  bytes_used: unknown;
  asset_count: unknown;
}

interface KindRow {
  kind: string;
  bytes: unknown;
  asset_count: unknown;
}

interface GrowthRow {
  bucket: string;
  bytes: unknown;
}

interface QuotaExceededRow {
  user_id: string;
  email: string;
  bytes_used: unknown;
  quota_bytes: unknown;
  over_bytes: unknown;
}

interface CleanupCursor extends Record<string, string | number> {
  startedAt: string;
  id: string;
}

/**
 * 存储运维统计与清理调度。
 *
 * 与仪表盘一致:所有汇总都用 `$queryRaw` + `Prisma.sql` 参数化聚合在库内完成,
 * 60 秒短期缓存只缓存统计数字(不含任何鉴权信息),清理动作一律入队由 Worker 执行。
 */
@Injectable()
export class AdminStorageService {
  private readonly logger = new Logger(AdminStorageService.name);
  private readonly env = loadEnv();

  private static readonly CACHE_PREFIX = 'admin:storage:overview:v1:';
  private static readonly CACHE_TTL_SECONDS = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly queue: QueueProducerService,
  ) {}

  // ---------------------------------------------------------------------------
  // 总览
  // ---------------------------------------------------------------------------

  async overview(query: StorageOverviewQuery): Promise<AdminStorageOverviewView> {
    const cacheKey = `${AdminStorageService.CACHE_PREFIX}top${query.topN}`;
    const cached = await this.redis.getJson<AdminStorageOverviewView>(cacheKey);
    if (cached) return cached;

    const dueBefore = new Date(Date.now() - this.env.ASSET_RECYCLE_DAYS * 86_400_000);
    const growthSince = new Date(Date.now() - 30 * 86_400_000);

    const [totals, topUsers, byKind, growth, quotaExceeded] = await Promise.all([
      this.queryAssetTotals(dueBefore),
      this.queryTopUsers(query.topN),
      this.queryByKind(),
      this.queryGrowth(growthSince),
      this.queryQuotaExceeded(),
    ]);

    const activeBytes = BigInt(toBigIntString(totals.active_bytes));
    const recycledBytes = BigInt(toBigIntString(totals.recycled_bytes));
    const orphanBytes = BigInt(toBigIntString(totals.orphan_bytes));

    const view: AdminStorageOverviewView = {
      // 对象存储中实际仍占用的字节:可用 + 回收期内 + 孤儿
      totalBytes: (activeBytes + recycledBytes + orphanBytes).toString(),
      activeBytes: activeBytes.toString(),
      recycledBytes: recycledBytes.toString(),
      orphanBytes: orphanBytes.toString(),
      assetCount: toNumber(totals.active_count),
      topUsers: topUsers.map((row) => ({
        userId: row.user_id,
        email: row.email,
        bytesUsed: toBigIntString(row.bytes_used),
        assetCount: toNumber(row.asset_count),
      })),
      growth30d: growth.map((row) => ({ date: row.bucket, bytes: toBigIntString(row.bytes) })),
      byKind: byKind.map((row) => ({
        kind: row.kind,
        bytes: toBigIntString(row.bytes),
        assetCount: toNumber(row.asset_count),
      })),
      pendingCleanup: {
        recycledAssetCount: toNumber(totals.recycled_count),
        recycledBytes: recycledBytes.toString(),
        dueAssetCount: toNumber(totals.due_count),
        dueBytes: toBigIntString(totals.due_bytes),
        recycleDays: this.env.ASSET_RECYCLE_DAYS,
      },
      quotaExceededUsers: quotaExceeded.map((row) => ({
        userId: row.user_id,
        email: row.email,
        bytesUsed: toBigIntString(row.bytes_used),
        quotaBytes: toBigIntString(row.quota_bytes),
        overBytes: toBigIntString(row.over_bytes),
      })),
      definitions: {
        totalBytes: '对象存储中仍占用的字节:ACTIVE + RECYCLED + ORPHAN 三类资产 byteSize 之和(PURGED 已物理清除,不计入)',
        activeBytes: '状态为 ACTIVE 的资产 byteSize 之和,即用户可正常访问的部分',
        recycledBytes: '状态为 RECYCLED 的资产 byteSize 之和:已删除但仍在回收期,依然占用对象存储',
        orphanBytes: '状态为 ORPHAN 的资产 byteSize 之和:上传后无业务引用且超过宽限期,等待清理',
        topUsers: '按 StorageUsage.bytesUsed 降序取前 N 名(该字段只统计 ACTIVE 资产,与 activeBytes 同口径)',
        growth30d: '最近 30 天按 Asset.confirmedAt 分天汇总的新增 byteSize,反映净增而非当前占用',
      },
      computedAt: new Date().toISOString(),
    };

    await this.redis.setJson(cacheKey, view, AdminStorageService.CACHE_TTL_SECONDS);
    return view;
  }

  private async queryAssetTotals(dueBefore: Date): Promise<AssetTotalsRow> {
    const rows = await this.prisma.db.$queryRaw<AssetTotalsRow[]>(Prisma.sql`
      SELECT
        (COALESCE(sum("byteSize") FILTER (WHERE status = 'ACTIVE'), 0))::text AS active_bytes,
        (count(*) FILTER (WHERE status = 'ACTIVE'))::int AS active_count,
        (COALESCE(sum("byteSize") FILTER (WHERE status = 'RECYCLED'), 0))::text AS recycled_bytes,
        (count(*) FILTER (WHERE status = 'RECYCLED'))::int AS recycled_count,
        (COALESCE(sum("byteSize") FILTER (WHERE status = 'ORPHAN'), 0))::text AS orphan_bytes,
        (COALESCE(sum("byteSize") FILTER (
          WHERE status = 'RECYCLED' AND "recycledAt" IS NOT NULL AND "recycledAt" < ${dueBefore}
        ), 0))::text AS due_bytes,
        (count(*) FILTER (
          WHERE status = 'RECYCLED' AND "recycledAt" IS NOT NULL AND "recycledAt" < ${dueBefore}
        ))::int AS due_count
      FROM assets
    `);
    return (
      rows[0] ?? {
        active_bytes: '0',
        active_count: 0,
        recycled_bytes: '0',
        recycled_count: 0,
        orphan_bytes: '0',
        due_bytes: '0',
        due_count: 0,
      }
    );
  }

  private async queryTopUsers(topN: number): Promise<TopUserRow[]> {
    return this.prisma.db.$queryRaw<TopUserRow[]>(Prisma.sql`
      SELECT
        su."userId" AS user_id,
        u.email AS email,
        (su."bytesUsed")::text AS bytes_used,
        su."assetCount" AS asset_count
      FROM storage_usage su
      JOIN users u ON u.id = su."userId" AND u."deletedAt" IS NULL
      WHERE su."bytesUsed" > 0
      ORDER BY su."bytesUsed" DESC
      LIMIT ${topN}
    `);
  }

  private async queryByKind(): Promise<KindRow[]> {
    return this.prisma.db.$queryRaw<KindRow[]>(Prisma.sql`
      SELECT
        kind::text AS kind,
        (COALESCE(sum("byteSize"), 0))::text AS bytes,
        (count(*))::int AS asset_count
      FROM assets
      WHERE status IN ('ACTIVE', 'RECYCLED', 'ORPHAN')
      GROUP BY 1
      ORDER BY 2 DESC
    `);
  }

  private async queryGrowth(since: Date): Promise<GrowthRow[]> {
    return this.prisma.db.$queryRaw<GrowthRow[]>(Prisma.sql`
      SELECT
        to_char(date_trunc('day', "confirmedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
        (COALESCE(sum("byteSize"), 0))::text AS bytes
      FROM assets
      WHERE "confirmedAt" IS NOT NULL AND "confirmedAt" >= ${since}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  /** 配额超限:两列比较无法用 Prisma where 表达,必须走 SQL */
  private async queryQuotaExceeded(): Promise<QuotaExceededRow[]> {
    return this.prisma.db.$queryRaw<QuotaExceededRow[]>(Prisma.sql`
      SELECT
        su."userId" AS user_id,
        u.email AS email,
        (su."bytesUsed")::text AS bytes_used,
        (su."quotaBytes")::text AS quota_bytes,
        (su."bytesUsed" - su."quotaBytes")::text AS over_bytes
      FROM storage_usage su
      JOIN users u ON u.id = su."userId" AND u."deletedAt" IS NULL
      WHERE su."bytesUsed" > su."quotaBytes"
      ORDER BY (su."bytesUsed" - su."quotaBytes") DESC
      LIMIT 100
    `);
  }

  // ---------------------------------------------------------------------------
  // 配额调整
  // ---------------------------------------------------------------------------

  /** 调整单用户配额。写审计,并失效总览缓存。 */
  async updateQuota(
    actor: AuthUser,
    userId: string,
    input: StorageQuotaUpdateInput,
    meta: ClientMeta,
  ): Promise<{ userId: string; quotaBytes: string; bytesUsed: string; overQuota: boolean }> {
    const nextQuota = BigInt(input.quotaBytes);
    if (nextQuota < QUOTA_MIN_BYTES || nextQuota > QUOTA_HARD_MAX_BYTES) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        `配额必须在 ${formatBytes(QUOTA_MIN_BYTES)} ~ ${formatBytes(QUOTA_HARD_MAX_BYTES)} 之间`,
      );
    }

    const user = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true },
    });
    if (!user) throw AppException.notFound('用户不存在或已删除');

    const before = await this.prisma.db.storageUsage.findUnique({ where: { userId } });
    const usage = await this.prisma.db.storageUsage.upsert({
      where: { userId },
      create: { userId, quotaBytes: nextQuota },
      update: { quotaBytes: nextQuota },
    });

    await this.redis.delByPrefix(AdminStorageService.CACHE_PREFIX);

    await this.audit.record({
      actor,
      action: 'admin.storage.quota.update',
      targetType: 'StorageUsage',
      targetId: userId,
      diff: this.audit.buildDiff(
        { quotaBytes: before?.quotaBytes.toString() ?? null },
        { quotaBytes: nextQuota.toString() },
      ),
      metadata: {
        targetEmail: user.email,
        reason: input.reason ?? null,
        bytesUsed: usage.bytesUsed.toString(),
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      userId,
      quotaBytes: usage.quotaBytes.toString(),
      bytesUsed: usage.bytesUsed.toString(),
      overQuota: usage.bytesUsed > usage.quotaBytes,
    };
  }

  // ---------------------------------------------------------------------------
  // 清理任务
  // ---------------------------------------------------------------------------

  /**
   * 触发清理。
   *
   * API **不同步执行**任何清理:先落一条 CleanupRun 记录(状态 queued),
   * 再通过 `QueueProducerService.enqueueMaintenance` 入队,由 apps/worker 消费。
   * `runKey` 用 CleanupRun 的 id,BullMQ 据此天然去重,重复点击不会跑两遍。
   */
  async triggerCleanup(
    actor: AuthUser,
    input: CleanupTriggerInput,
    meta: ClientMeta,
  ): Promise<CleanupRunView> {
    const run = await this.prisma.db.cleanupRun.create({
      data: {
        kind: input.kind,
        dryRun: input.dryRun,
        status: 'queued',
        triggeredBy: actor.id,
      },
    });

    try {
      await this.queue.enqueueMaintenance({
        kind: MAINTENANCE_KIND[input.kind],
        dryRun: input.dryRun,
        limit: input.limit,
        triggeredBy: actor.id,
        runKey: run.id,
      });
    } catch (err) {
      // 入队失败要把记录标记为失败,否则界面上会留一条永远 queued 的记录
      await this.prisma.db.cleanupRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorMessage: `入队失败:${(err as Error).message}`,
        },
      });
      throw AppException.unavailable('清理任务入队失败,请稍后重试');
    }

    await this.audit.record({
      actor,
      action: 'admin.storage.cleanup.trigger',
      targetType: 'CleanupRun',
      targetId: run.id,
      metadata: { kind: input.kind, dryRun: input.dryRun, limit: input.limit },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    this.logger.log(
      `管理员 ${actor.email} 触发清理 ${input.kind}(dryRun=${input.dryRun}, limit=${input.limit}),run=${run.id}`,
    );
    return this.toCleanupView(run);
  }

  /** 历史清理执行记录 */
  async listCleanupRuns(
    query: CleanupRunListQuery,
  ): Promise<{ items: CleanupRunView[]; nextCursor: string | null; hasMore: boolean }> {
    const cursor = query.cursor ? decodeCursor<CleanupCursor>(query.cursor) : null;
    const startedAt = cursor?.startedAt ? new Date(cursor.startedAt) : null;

    const rows = await this.prisma.db.cleanupRun.findMany({
      where: {
        ...(query.kind === 'ALL' ? {} : { kind: query.kind }),
        ...(startedAt && cursor && !Number.isNaN(startedAt.getTime())
          ? {
              OR: [{ startedAt: { lt: startedAt } }, { startedAt, id: { lt: cursor.id } }],
            }
          : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toCleanupView(row)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ startedAt: last.startedAt.toISOString(), id: last.id })
          : null,
      hasMore: rows.length > query.limit,
    };
  }

  private toCleanupView(run: {
    id: string;
    kind: string;
    dryRun: boolean;
    status: string;
    scanned: number;
    matched: number;
    affected: number;
    freedBytes: bigint;
    sample: unknown;
    startedAt: Date;
    finishedAt: Date | null;
    errorMessage: string | null;
  }): CleanupRunView {
    return {
      id: run.id,
      kind: run.kind,
      dryRun: run.dryRun,
      status: run.status,
      scanned: run.scanned,
      matched: run.matched,
      affected: run.affected,
      freedBytes: run.freedBytes.toString(),
      sample: Array.isArray(run.sample) ? run.sample : [],
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      errorMessage: run.errorMessage,
    };
  }

  /** 供接口回显的配额区间 */
  static get quotaBounds(): { min: string; max: string } {
    return { min: QUOTA_MIN_BYTES.toString(), max: QUOTA_HARD_MAX_BYTES.toString() };
  }
}