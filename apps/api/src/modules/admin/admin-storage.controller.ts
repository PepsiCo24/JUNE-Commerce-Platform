import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ROLE_ADMIN, ROLE_LEVEL, ROLE_SUPER_ADMIN } from '@june/db';
import { cleanupRunSchema, idSchema, type CleanupRunView } from '@june/shared';
import type { z } from 'zod';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import {
  AdminStorageService,
  cleanupRunListQuerySchema,
  storageOverviewQuerySchema,
  storageQuotaUpdateSchema,
  type CleanupRunListQuery,
  type StorageOverviewQuery,
  type StorageQuotaUpdateInput,
} from './admin-storage.service';
import type { ClientMeta } from './admin-user.service';
import type { AdminStorageOverviewView } from './admin.types';

type CleanupInput = z.infer<typeof cleanupRunSchema>;

/**
 * 存储运维。
 * 统计对管理员开放;调整配额与触发清理属于高危操作,提升到超级管理员。
 */
@Controller('admin/storage')
@MinRoleLevel(ROLE_LEVEL[ROLE_ADMIN])
export class AdminStorageController {
  constructor(private readonly storage: AdminStorageService) {}

  /** 总用量、按用户 Top N、按 kind 分布、30 天增长、回收站待清理量、配额超限用户 */
  @Get('overview')
  async overview(
    @Query(zodQuery(storageOverviewQuerySchema)) query: StorageOverviewQuery,
  ): Promise<AdminStorageOverviewView> {
    return this.storage.overview(query);
  }

  /** 配额区间(硬上限),前端表单据此校验 */
  @Get('quota-bounds')
  quotaBounds(): { min: string; max: string } {
    return AdminStorageService.quotaBounds;
  }

  /** 调整单用户存储配额(改 StorageUsage.quotaBytes),写审计 */
  @Put('users/:userId/quota')
  @MinRoleLevel(ROLE_LEVEL[ROLE_SUPER_ADMIN])
  async updateQuota(
    @CurrentUser() actor: AuthUser,
    @Param('userId', zodBody(idSchema)) userId: string,
    @Body(zodBody(storageQuotaUpdateSchema)) dto: StorageQuotaUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<{ userId: string; quotaBytes: string; bytesUsed: string; overQuota: boolean }> {
    return this.storage.updateQuota(actor, userId, dto, meta);
  }

  /**
   * 触发清理任务。**只入队,不在 API 里同步执行**,立刻返回 CleanupRun 的 id。
   * `dryRun=true` 时 Worker 只统计不删除。
   */
  @Post('cleanup')
  @HttpCode(202)
  @MinRoleLevel(ROLE_LEVEL[ROLE_SUPER_ADMIN])
  async cleanup(
    @CurrentUser() actor: AuthUser,
    @Body(zodBody(cleanupRunSchema)) dto: CleanupInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<CleanupRunView> {
    return this.storage.triggerCleanup(
      actor,
      { kind: dto.kind, dryRun: dto.dryRun, limit: dto.limit },
      meta,
    );
  }

  /** 清理执行历史 */
  @Get('cleanup-runs')
  async cleanupRuns(
    @Query(zodQuery(cleanupRunListQuerySchema)) query: CleanupRunListQuery,
  ): Promise<{ items: CleanupRunView[]; nextCursor: string | null; hasMore: boolean }> {
    return this.storage.listCleanupRuns(query);
  }
}
