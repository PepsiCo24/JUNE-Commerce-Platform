import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  idSchema,
  shopCreateSchema,
  shopDeleteSchema,
  shopListQuerySchema,
  shopResetInheritanceSchema,
  shopUpdateSchema,
  type PageResult,
  type ShopCreateInput,
  type ShopDeleteInput,
  type ShopDetail,
  type ShopGraph,
  type ShopStats,
  type ShopSummary,
  type ShopUpdateInput,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import type { ClientMeta, ShopDeleteResult } from './commerce.types';
import { ShopsService, type ShopListQuery, type ShopResetInheritanceInput } from './shops.service';

@Controller('shops')
export class ShopsController {
  constructor(private readonly shops: ShopsService) {}

  /** 店铺列表。页码分页,关联计数批量取。 */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(zodQuery(shopListQuerySchema)) query: ShopListQuery,
  ): Promise<PageResult<ShopSummary>> {
    return this.shops.list(user, query);
  }

  /** 概览统计。注意要声明在 :id 之前,否则会被当成店铺 id。 */
  @Get('stats')
  async stats(@CurrentUser() user: AuthUser): Promise<ShopStats> {
    return this.shops.stats(user);
  }

  /** 主子店关系图(前端交给 Dagre 布局),只含当前用户的店铺 */
  @Get('graph')
  async graph(@CurrentUser() user: AuthUser): Promise<ShopGraph> {
    return this.shops.graph(user);
  }

  /** 店铺详情。inheritance 明确给出每个可继承字段是"继承"还是"已覆盖"。 */
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<ShopDetail> {
    return this.shops.detail(user, id);
  }

  /** 创建店铺。传 parentId 即创建子店铺,默认继承主店的平台/联系人/联系方式/备注。 */
  @Post()
  @HttpCode(201)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(shopCreateSchema)) dto: ShopCreateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ShopDetail> {
    return this.shops.create(user, dto, meta);
  }

  /**
   * 更新店铺。
   * 子店:显式传入可继承字段即视为覆盖。
   * 主店:propagateToChildren=true 时同步到"未覆盖该字段"的子店。
   */
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(shopUpdateSchema)) dto: ShopUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ShopDetail> {
    return this.shops.update(user, id, dto, meta);
  }

  /** 重置继承:清除指定字段的覆盖标记并重新取主店当前的值 */
  @Post(':id/reset-inheritance')
  @HttpCode(200)
  async resetInheritance(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(shopResetInheritanceSchema)) dto: ShopResetInheritanceInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ShopDetail> {
    return this.shops.resetInheritance(user, id, dto, meta);
  }

  /**
   * 删除店铺。必须显式声明子店 / 商品 / 凭据的处理方式并回填店铺名称二次确认,
   * 返回体给出各类依赖的实际影响数量,不做静默级联删除。
   */
  @Delete(':id')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(shopDeleteSchema)) dto: ShopDeleteInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ShopDeleteResult> {
    return this.shops.remove(user, id, dto, meta);
  }
}
