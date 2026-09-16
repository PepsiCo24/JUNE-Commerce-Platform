import { Controller, Get, Param, Query } from '@nestjs/common';
import { ROLE_ADMIN, ROLE_LEVEL } from '@june/db';
import { idSchema } from '@june/shared';

import { MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import {
  adminTaskListQuerySchema,
  adminTaskStatsQuerySchema,
  AdminTaskService,
  type AdminTaskListQuery,
  type AdminTaskStatsQuery,
} from './admin-task.service';
import type {
  AdminTaskDetailView,
  AdminTaskListItem,
  AdminTaskStatsResponse,
} from './admin.types';

/**
 * 任务记录(只读)。
 *
 * 管理站不提供"代替用户重试/取消"的写接口:重试涉及可能已计费的上游调用,
 * 必须由任务所属用户在工作台自行决定。
 */
@Controller('admin/tasks')
@MinRoleLevel(ROLE_LEVEL[ROLE_ADMIN])
export class AdminTaskController {
  constructor(private readonly tasks: AdminTaskService) {}

  /** 任务记录列表:按用户/状态/类型/供应商/模型/时间筛选,游标分页 */
  @Get()
  async list(
    @Query(zodQuery(adminTaskListQuerySchema)) query: AdminTaskListQuery,
  ): Promise<{ items: AdminTaskListItem[]; nextCursor: string | null; hasMore: boolean }> {
    return this.tasks.list(query);
  }

  /**
   * 按供应商/模型的成功率与 P95 上游耗时。
   * 路由声明在 `:id` 之前,避免 "stats" 被当成任务 id。
   */
  @Get('stats')
  async stats(
    @Query(zodQuery(adminTaskStatsQuerySchema)) query: AdminTaskStatsQuery,
  ): Promise<AdminTaskStatsResponse> {
    return this.tasks.stats(query);
  }

  /** 任务详情:含各 GenerationResult 状态;params 与 errorMessage 已脱敏 */
  @Get(':id')
  async detail(@Param('id', zodBody(idSchema)) id: string): Promise<AdminTaskDetailView> {
    return this.tasks.detail(id);
  }
}
