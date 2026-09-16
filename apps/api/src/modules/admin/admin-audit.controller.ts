import { Controller, Get, Query } from '@nestjs/common';
import { ROLE_ADMIN, ROLE_LEVEL } from '@june/db';
import { auditLogQuerySchema, type AuditLogView } from '@june/shared';

import { MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodQuery } from '../../common/validation/zod-body.pipe';
import { AdminAuditService, type AuditLogQuery } from './admin-audit.service';

/**
 * 审计日志(只读)。
 *
 * 这里**故意没有** POST / PUT / DELETE 路由:审计记录一旦写入不可修改、不可删除,
 * 否则"谁改了什么"就失去证明力。清理与归档由 Worker 的维护任务负责。
 */
@Controller('admin/audit-logs')
@MinRoleLevel(ROLE_LEVEL[ROLE_ADMIN])
export class AdminAuditController {
  constructor(private readonly auditLogs: AdminAuditService) {}

  /** 按 actor / action / targetType / 时间筛选,游标分页 */
  @Get()
  async list(
    @Query(zodQuery(auditLogQuerySchema)) query: AuditLogQuery,
  ): Promise<{ items: AuditLogView[]; nextCursor: string | null; hasMore: boolean }> {
    return this.auditLogs.list(query);
  }

  /** 可筛选的 action 与 targetType 枚举(distinct 查询 + 5 分钟缓存) */
  @Get('actions')
  async actions(): Promise<{ actions: string[]; targetTypes: string[]; cachedAt: string }> {
    return this.auditLogs.filterOptions();
  }
}
