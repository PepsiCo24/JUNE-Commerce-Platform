import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  alipayAccountCreateSchema,
  alipayAccountListQuerySchema,
  alipayAccountUpdateSchema,
  idSchema,
  type AlipayAccountCreateInput,
  type AlipayAccountDetail,
  type AlipayAccountSummary,
  type AlipayAccountUpdateInput,
  type AlipayPasswordRevealResponse,
  type AlipayPhoneRevealResponse,
  type PageResult,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, RequireReauth } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import {
  AlipayAccountsService,
  type AlipayAccountListQuery,
} from './alipay.service';
import type { ClientMeta } from './commerce.types';

@Controller('alipay-accounts')
export class AlipayAccountsController {
  constructor(private readonly alipay: AlipayAccountsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(zodQuery(alipayAccountListQuerySchema)) query: AlipayAccountListQuery,
  ): Promise<PageResult<AlipayAccountSummary>> {
    return this.alipay.list(user, query);
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<AlipayAccountDetail> {
    return this.alipay.detail(user, id);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(alipayAccountCreateSchema)) dto: AlipayAccountCreateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AlipayAccountSummary> {
    return this.alipay.create(user, dto, meta);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(alipayAccountUpdateSchema)) dto: AlipayAccountUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AlipayAccountSummary> {
    return this.alipay.update(user, id, dto, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<void> {
    await this.alipay.remove(user, id, meta);
  }

  @Post(':id/reveal-phone')
  @RequireReauth()
  @HttpCode(200)
  async revealPhone(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AlipayPhoneRevealResponse> {
    return this.alipay.revealPhone(user, id, meta);
  }

  @Post(':id/reveal-password')
  @RequireReauth()
  @HttpCode(200)
  async revealPassword(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AlipayPasswordRevealResponse> {
    return this.alipay.revealPassword(user, id, meta);
  }

  @Post(':id/copy-audit')
  @RequireReauth()
  @HttpCode(204)
  async copyAudit(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<void> {
    await this.alipay.recordCopy(user, id, meta);
  }
}
