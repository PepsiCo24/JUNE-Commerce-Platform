import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ROLE_ADMIN, ROLE_LEVEL, ROLE_SUPER_ADMIN } from '@june/db';
import {
  adminCreateAdminSchema,
  adminUserListQuerySchema,
  adminUserRoleSchema,
  adminUserStatusSchema,
  cursorQuerySchema,
  idSchema,
  type AdminUserSummary,
  type CursorQuery,
  type PageResult,
} from '@june/shared';
import { z } from 'zod';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import {
  AdminUserService,
  type AdminCreateAdminInput,
  type AdminUserListQuery,
  type AdminUserRoleInput,
  type AdminUserStatusInput,
  type ClientMeta,
} from './admin-user.service';
import type {
  AdminProductSummaryView,
  AdminShopDetailView,
  AdminUserDetailView,
} from './admin.types';

/** 删除用户时可附带原因,写入审计 */
const removeReasonSchema = z.object({ reason: z.string().trim().max(300).optional() });

/**
 * 用户管理。
 *
 * `RolesGuard` 已保证 `/api/admin/**` 需要管理员等级;控制器再显式声明一次(双重保险)。
 * 角色相关的接口额外提升到超级管理员等级。
 */
@Controller('admin/users')
@MinRoleLevel(ROLE_LEVEL[ROLE_ADMIN])
export class AdminUserController {
  constructor(private readonly users: AdminUserService) {}

  /** 用户列表:搜索(email / displayName,大小写不敏感)+ 状态/角色筛选 + 分页 */
  @Get()
  async list(
    @Query(zodQuery(adminUserListQuerySchema)) query: AdminUserListQuery,
  ): Promise<PageResult<AdminUserSummary>> {
    return this.users.list(query);
  }

  /**
   * 创建管理员(超级管理员专属)。
   * 初始超管仍用 `pnpm admin:init`;本接口用于后续在管理站新增管理员。
   * 密码不回传、不进审计明文。
   */
  @Post()
  @MinRoleLevel(ROLE_LEVEL[ROLE_SUPER_ADMIN])
  async createAdmin(
    @CurrentUser() actor: AuthUser,
    @Body(zodBody(adminCreateAdminSchema)) dto: AdminCreateAdminInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminUserSummary> {
    return this.users.createAdmin(actor, dto, meta);
  }

  /** 用户详情:资料、角色、会话数、最后活跃、存储用量、店铺(含主子关系)、商品统计 */
  @Get(':id')
  async detail(@Param('id', zodBody(idSchema)) id: string): Promise<AdminUserDetailView> {
    return this.users.detail(id);
  }

  /**
   * 下钻:某用户的店铺列表。
   * 返回的凭据只有 { id, purpose, account, loginUrl, note } —— **password 一律省略**。
   */
  @Get(':id/shops')
  async shops(
    @Param('id', zodBody(idSchema)) id: string,
    @Query(zodQuery(cursorQuerySchema)) query: CursorQuery,
  ): Promise<{ items: AdminShopDetailView[]; nextCursor: string | null; hasMore: boolean }> {
    return this.users.listShops(id, query);
  }

  /** 下钻:某用户某店铺下的商品列表 */
  @Get(':id/shops/:shopId/products')
  async shopProducts(
    @Param('id', zodBody(idSchema)) id: string,
    @Param('shopId', zodBody(idSchema)) shopId: string,
    @Query(zodQuery(cursorQuerySchema)) query: CursorQuery,
  ): Promise<{ items: AdminProductSummaryView[]; nextCursor: string | null; hasMore: boolean }> {
    return this.users.listShopProducts(id, shopId, query);
  }

  /** 启用 / 禁用。禁用会递增 sessionEpoch 并撤销该用户全部会话。 */
  @Put(':id/status')
  async setStatus(
    @CurrentUser() actor: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(adminUserStatusSchema)) dto: AdminUserStatusInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<{ id: string; status: 'ACTIVE' | 'DISABLED' }> {
    return this.users.setStatus(actor, id, dto, meta);
  }

  /**
   * 角色管理(超级管理员专属):覆盖式设置角色,授予/撤销 admin 与 super_admin 都走这里。
   * 撤销最后一个超级管理员会被拒绝(LAST_SUPER_ADMIN)。
   */
  @Put(':id/roles')
  @MinRoleLevel(ROLE_LEVEL[ROLE_SUPER_ADMIN])
  async setRoles(
    @CurrentUser() actor: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(adminUserRoleSchema)) dto: AdminUserRoleInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<{ id: string; roles: string[] }> {
    return this.users.setRoles(actor, id, dto, meta);
  }

  /**
   * 删除用户(软删除,超级管理员专属)。同样受最后一个超级管理员保护。
   * 删除原因走查询串:DELETE 请求体在部分客户端会被丢弃,不适合承载必要信息。
   */
  @Delete(':id')
  @MinRoleLevel(ROLE_LEVEL[ROLE_SUPER_ADMIN])
  async remove(
    @CurrentUser() actor: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Query(zodQuery(removeReasonSchema)) dto: z.infer<typeof removeReasonSchema>,
    @ClientInfo() meta: ClientMeta,
  ): Promise<{ id: string; deleted: true }> {
    return this.users.remove(actor, id, dto.reason, meta);
  }
}
