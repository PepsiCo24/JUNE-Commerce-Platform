import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ROLE_LEVEL } from '@june/db';
import {
  idSchema,
  modelConfigCreateSchema,
  modelConfigUpdateSchema,
  modelPolicyUpdateSchema,
  providerCreateSchema,
  providerUpdateSchema,
  type AdminModelConfigView,
  type AdminProviderView,
  type ModelConfigCreateInput,
  type ModelPolicyUpdateInput,
  type ModelSelectionPolicy,
  type ProviderCreateInput,
  type ProviderTestResult,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/validation/zod-body.pipe';
import {
  ModelAdminService,
  type ClientMeta,
  type ModelConfigUpdateInput,
  type ModelDeleteResult,
  type ProviderUpdateInput,
} from './model-admin.service';

/**
 * 模型与供应商管理接口。
 *
 * 路径挂在 /api/admin 下,RolesGuard 会无条件要求管理员等级;
 * 这里再显式声明一次,保证即使守卫策略调整也不会放宽。
 *
 * 所有读接口只回 apiKeyMasked,**任何情况下都不返回 API Key 明文**。
 */
@Controller('admin/models')
@MinRoleLevel(ROLE_LEVEL.admin)
export class ModelAdminController {
  constructor(private readonly admin: ModelAdminService) {}

  // ---------------------------------------------------------------------------
  // 供应商
  // ---------------------------------------------------------------------------

  @Get('providers')
  async listProviders(): Promise<AdminProviderView[]> {
    return this.admin.listProviders();
  }

  @Post('providers')
  @HttpCode(201)
  async createProvider(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(providerCreateSchema)) dto: ProviderCreateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminProviderView> {
    return this.admin.createProvider(user, dto, meta);
  }

  @Patch('providers/:id')
  async updateProvider(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(providerUpdateSchema)) dto: ProviderUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminProviderView> {
    return this.admin.updateProvider(user, id, dto, meta);
  }

  /** 名下仍有模型时改为停用而非删除,返回体会说明实际执行的动作 */
  @Delete('providers/:id')
  async deleteProvider(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ModelDeleteResult> {
    return this.admin.deleteProvider(user, id, meta);
  }

  /** 连通性探测(非计费调用)。真实模型联调由 Worker 侧适配器负责。 */
  @Post('providers/:id/test')
  @HttpCode(200)
  async testProvider(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ProviderTestResult> {
    return this.admin.testProvider(user, id, meta);
  }

  // ---------------------------------------------------------------------------
  // 策略。放在 :id 路由之前声明,避免 policy 被当成模型 id 匹配。
  // ---------------------------------------------------------------------------

  @Get('policy')
  async getPolicy(): Promise<ModelSelectionPolicy> {
    return this.admin.getPolicy();
  }

  @Put('policy')
  async updatePolicy(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(modelPolicyUpdateSchema)) dto: ModelPolicyUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ModelSelectionPolicy> {
    return this.admin.updatePolicy(user, dto, meta);
  }

  // ---------------------------------------------------------------------------
  // 模型配置
  // ---------------------------------------------------------------------------

  @Get()
  async listModels(): Promise<AdminModelConfigView[]> {
    return this.admin.listModels();
  }

  @Post()
  @HttpCode(201)
  async createModel(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(modelConfigCreateSchema)) dto: ModelConfigCreateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminModelConfigView> {
    return this.admin.createModel(user, dto, meta);
  }

  @Patch(':id')
  async updateModel(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(modelConfigUpdateSchema)) dto: ModelConfigUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminModelConfigView> {
    return this.admin.updateModel(user, id, dto, meta);
  }

  /** 被历史任务引用时改为软删除 + 停用,返回体带 taskRefCount 提示 */
  @Delete(':id')
  async deleteModel(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ModelDeleteResult> {
    return this.admin.deleteModel(user, id, meta);
  }

  /** 设为该能力下的默认模型(同能力互斥) */
  @Post(':id/default')
  @HttpCode(200)
  async setDefault(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminModelConfigView> {
    return this.admin.setDefault(user, id, meta);
  }
}
