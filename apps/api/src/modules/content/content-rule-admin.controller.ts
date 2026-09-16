import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ROLE_LEVEL } from '@june/db';
import {
  contentRuleCreateSchema,
  contentRuleUpdateSchema,
  idSchema,
  pageQuerySchema,
  type AdminContentRuleView,
  type ContentRuleCreateInput,
  type PageResult,
} from '@june/shared';
import { z } from 'zod';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import {
  ContentRuleAdminService,
  type ClientMeta,
  type ContentRuleUpdateInput,
  type ContentRuleVersionView,
} from './content-rule-admin.service';

const ruleListQuerySchema = pageQuerySchema.extend({
  type: z
    .enum(['ALL', 'SYSTEM_PROMPT', 'BANNED_WORD', 'BANNED_PHRASE', 'BANNED_CATEGORY', 'PLATFORM_RULE'])
    .default('ALL'),
  enabled: z.enum(['ALL', 'ENABLED', 'DISABLED']).default('ALL'),
});

const toggleSchema = z.object({ enabled: z.boolean() });

/**
 * 内容规则管理接口。
 *
 * 每次写操作都会写入 ContentRuleVersion 快照并自增 ContentRule.version,
 * 同时 bumpRevision('content') 触发热更新广播。
 */
@Controller('admin/content-rules')
@MinRoleLevel(ROLE_LEVEL.admin)
export class ContentRuleAdminController {
  constructor(private readonly admin: ContentRuleAdminService) {}

  @Get()
  async list(
    @Query(zodQuery(ruleListQuerySchema)) query: z.infer<typeof ruleListQuerySchema>,
  ): Promise<PageResult<AdminContentRuleView>> {
    return this.admin.list(query);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(contentRuleCreateSchema)) dto: ContentRuleCreateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminContentRuleView> {
    return this.admin.create(user, dto, meta);
  }

  /** 版本历史。路由声明在 :id 之前,避免被通配匹配吞掉。 */
  @Get(':id/versions')
  async versions(@Param('id', zodBody(idSchema)) id: string): Promise<ContentRuleVersionView[]> {
    return this.admin.listVersions(id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(contentRuleUpdateSchema)) dto: ContentRuleUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminContentRuleView> {
    return this.admin.update(user, id, dto, meta);
  }

  @Post(':id/enabled')
  @HttpCode(200)
  async toggle(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(toggleSchema)) dto: z.infer<typeof toggleSchema>,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminContentRuleView> {
    return this.admin.setEnabled(user, id, dto.enabled, meta);
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<{ deleted: true }> {
    return this.admin.remove(user, id, meta);
  }
}
