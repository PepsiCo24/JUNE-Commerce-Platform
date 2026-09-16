import { Injectable } from '@nestjs/common';
import { Prisma } from '@june/db';
import { decodeCursor, encodeCursor, type AuditLogView } from '@june/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

/** 与 `@june/shared` 的 auditLogQuerySchema 推断结果一致 */
export interface AuditLogQuery {
  cursor?: string;
  limit: number;
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

interface AuditCursor extends Record<string, string | number> {
  createdAt: string;
  id: string;
}

/**
 * 审计日志查询。
 *
 * **只读**:本服务与对应控制器都不提供任何删除或修改审计记录的能力,
 * 审计的价值来自不可篡改。历史记录的容量控制由 Worker 的归档任务负责,
 * 不通过管理站接口删除。
 */
@Injectable()
export class AdminAuditService {
  private static readonly ACTIONS_CACHE_KEY = 'admin:audit:actions:v1';
  private static readonly ACTIONS_CACHE_TTL_SECONDS = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async list(
    query: AuditLogQuery,
  ): Promise<{ items: AuditLogView[]; nextCursor: string | null; hasMore: boolean }> {
    const rows = await this.prisma.db.auditLog.findMany({
      where: this.buildWhere(query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        actorId: true,
        actorEmail: true,
        actorRole: true,
        action: true,
        targetType: true,
        targetId: true,
        diff: true,
        metadata: true,
        ip: true,
        result: true,
        createdAt: true,
      },
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorEmail: row.actorEmail,
        actorRole: row.actorRole,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        // diff/metadata 在写入时已由 AuditService 脱敏,这里原样返回
        diff: row.diff ?? null,
        metadata: row.metadata ?? null,
        ip: row.ip,
        result: row.result,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      hasMore: rows.length > query.limit,
    };
  }

  private buildWhere(query: AuditLogQuery): Prisma.AuditLogWhereInput {
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    const cursor = query.cursor ? decodeCursor<AuditCursor>(query.cursor) : null;
    const cursorAt = cursor?.createdAt ? new Date(cursor.createdAt) : null;

    return {
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
      ...(cursor && cursorAt && !Number.isNaN(cursorAt.getTime())
        ? {
            OR: [{ createdAt: { lt: cursorAt } }, { createdAt: cursorAt, id: { lt: cursor.id } }],
          }
        : {}),
    };
  }

  /**
   * 可筛选的 action / targetType 枚举。
   * `SELECT DISTINCT` 在审计表上开销不小,因此缓存 5 分钟——
   * 这只是筛选下拉框的候选值,晚几分钟出现新动作类型不影响任何鉴权或数据正确性。
   */
  async filterOptions(): Promise<{ actions: string[]; targetTypes: string[]; cachedAt: string }> {
    const cached = await this.redis.getJson<{
      actions: string[];
      targetTypes: string[];
      cachedAt: string;
    }>(AdminAuditService.ACTIONS_CACHE_KEY);
    if (cached) return cached;

    const [actions, targetTypes] = await Promise.all([
      this.prisma.db.$queryRaw<Array<{ action: string }>>(Prisma.sql`
        SELECT DISTINCT action FROM audit_logs ORDER BY action ASC LIMIT 500
      `),
      this.prisma.db.$queryRaw<Array<{ targetType: string }>>(Prisma.sql`
        SELECT DISTINCT "targetType" FROM audit_logs ORDER BY "targetType" ASC LIMIT 200
      `),
    ]);

    const payload = {
      actions: actions.map((r) => r.action),
      targetTypes: targetTypes.map((r) => r.targetType),
      cachedAt: new Date().toISOString(),
    };
    await this.redis.setJson(
      AdminAuditService.ACTIONS_CACHE_KEY,
      payload,
      AdminAuditService.ACTIONS_CACHE_TTL_SECONDS,
    );
    return payload;
  }
}