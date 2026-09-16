import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ROLE_LEVEL, ROLE_SUPER_ADMIN } from '@june/db';
import { z } from 'zod';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import {
  AdminConfigService,
  systemConfigKeySchema,
  systemConfigListQuerySchema,
  systemConfigUpsertSchema,
  type SystemConfigListQuery,
  type SystemConfigUpsertInput,
} from './admin-config.service';
import type { ClientMeta } from './admin-user.service';
import type { AdminSystemConfigView } from './admin.types';

const removeReasonSchema = z.object({ reason: z.string().trim().max(300).optional() });

/**
 * 系统配置(超级管理员专属)。
 *
 * 敏感项(isSecret)写入时接受明文并立即加密,读取只返回掩码。
 * 每次写操作都会自增配置修订号,通过 SSE 通知前端补拉公开配置(只推版本号)。
 */
@Controller('admin/system-configs')
@MinRoleLevel(ROLE_LEVEL[ROLE_SUPER_ADMIN])
export class AdminConfigController {
  constructor(private readonly configs: AdminConfigService) {}

  @Get()
  async list(
    @Query(zodQuery(systemConfigListQuerySchema)) query: SystemConfigListQuery,
  ): Promise<AdminSystemConfigView[]> {
    return this.configs.list(query);
  }

  @Get(':key')
  async get(
    @Param('key', zodBody(systemConfigKeySchema)) key: string,
  ): Promise<AdminSystemConfigView> {
    return this.configs.get(key);
  }

  /** 新建或更新。危险键(如并发上限)必须通过 zod 校验与硬上限限制。 */
  @Put(':key')
  async upsert(
    @CurrentUser() actor: AuthUser,
    @Param('key', zodBody(systemConfigKeySchema)) key: string,
    @Body(zodBody(systemConfigUpsertSchema)) dto: SystemConfigUpsertInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminSystemConfigView> {
    return this.configs.upsert(actor, key, dto, meta);
  }

  /** 删除配置项。受保护的键(分享密钥、并发上限等)不允许删除。 */
  @Delete(':key')
  async remove(
    @CurrentUser() actor: AuthUser,
    @Param('key', zodBody(systemConfigKeySchema)) key: string,
    @Query(zodQuery(removeReasonSchema)) query: z.infer<typeof removeReasonSchema>,
    @ClientInfo() meta: ClientMeta,
  ): Promise<{ key: string; deleted: true }> {
    return this.configs.remove(actor, key, query.reason, meta);
  }
}
