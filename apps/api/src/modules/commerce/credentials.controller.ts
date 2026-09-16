import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  credentialCreateSchema,
  credentialListQuerySchema,
  credentialUpdateSchema,
  idSchema,
  type CredentialCreateInput,
  type CredentialRevealResponse,
  type CredentialSummary,
  type PageResult,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, RequireReauth } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import type { ClientMeta } from './commerce.types';
import {
  CredentialsService,
  type CredentialListQuery,
  type CredentialUpdateInput,
} from './credentials.service';

@Controller('shops/:shopId/credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  /** 列表 / 搜索(q 匹配用途、账号、备注)。密码字段恒为固定掩码。 */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param('shopId', zodBody(idSchema)) shopId: string,
    @Query(zodQuery(credentialListQuerySchema)) query: CredentialListQuery,
  ): Promise<PageResult<CredentialSummary>> {
    return this.credentials.list(user, shopId, query);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentUser() user: AuthUser,
    @Param('shopId', zodBody(idSchema)) shopId: string,
    @Body(zodBody(credentialCreateSchema)) dto: CredentialCreateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<CredentialSummary> {
    return this.credentials.create(user, shopId, dto, meta);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('shopId', zodBody(idSchema)) shopId: string,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(credentialUpdateSchema)) dto: CredentialUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<CredentialSummary> {
    return this.credentials.update(user, shopId, id, dto, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('shopId', zodBody(idSchema)) shopId: string,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<void> {
    await this.credentials.remove(user, shopId, id, meta);
  }

  /**
   * 取回明文密码。唯一的解密入口。
   * 必须带 x-june-reauth 一次性令牌(ReauthGuard 校验并消费),并强制写审计。
   */
  @Post(':id/reveal')
  @RequireReauth()
  @HttpCode(200)
  async reveal(
    @CurrentUser() user: AuthUser,
    @Param('shopId', zodBody(idSchema)) shopId: string,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<CredentialRevealResponse> {
    return this.credentials.reveal(user, shopId, id, meta);
  }

  /** 前端"复制密码"时上报:只写审计,不返回任何明文 */
  @Post(':id/copy-audit')
  @RequireReauth()
  @HttpCode(204)
  async copyAudit(
    @CurrentUser() user: AuthUser,
    @Param('shopId', zodBody(idSchema)) shopId: string,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<void> {
    await this.credentials.recordCopy(user, shopId, id, meta);
  }
}
