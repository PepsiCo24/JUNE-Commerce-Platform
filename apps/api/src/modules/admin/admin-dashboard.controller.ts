import { Controller, Get, Query } from '@nestjs/common';
import { ROLE_ADMIN, ROLE_LEVEL } from '@june/db';
import { dashboardQuerySchema } from '@june/shared';
import type { z } from 'zod';

import { MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodQuery } from '../../common/validation/zod-body.pipe';
import { AdminDashboardService } from './admin-dashboard.service';
import { MAX_RANGE_DAYS } from './admin-stats.util';
import type { AdminDashboardView } from './admin.types';

type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/**
 * 仪表盘。
 *
 * `RolesGuard` 已对 `/api/admin/**` 做无条件管理员校验,这里再显式声明一次最低等级,
 * 属于双重保险:即使将来路径前缀调整,控制器自身的声明依然生效。
 */
@Controller('admin/dashboard')
@MinRoleLevel(ROLE_LEVEL[ROLE_ADMIN])
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  /**
   * 全站统计与趋势。每个指标都带 `definition` 口径文案,前端直接展示。
   * 结果有 60 秒短期缓存(见 AdminDashboardService 的缓存边界说明)。
   */
  @Get()
  async overview(
    @Query(zodQuery(dashboardQuerySchema)) query: DashboardQuery,
  ): Promise<AdminDashboardView> {
    return this.dashboard.getDashboard(query);
  }

  /** 统计口径与区间限制的元信息,前端用于渲染说明与日期选择器上限 */
  @Get('meta')
  meta(): { maxRangeDays: number; granularities: string[]; cacheTtlSeconds: number } {
    return { maxRangeDays: MAX_RANGE_DAYS, granularities: ['day', 'week'], cacheTtlSeconds: 60 };
  }

  /**
   * 强制失效统计缓存后重新聚合。
   * 只清理统计缓存,与权限、模型停用状态无关(那些判断本就不读缓存)。
   */
  @Get('refresh')
  async refresh(
    @Query(zodQuery(dashboardQuerySchema)) query: DashboardQuery,
  ): Promise<AdminDashboardView & { invalidatedKeys: number }> {
    const { invalidatedKeys } = await this.dashboard.refresh();
    const view = await this.dashboard.getDashboard(query);
    return { ...view, invalidatedKeys };
  }
}
