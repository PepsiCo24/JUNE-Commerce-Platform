import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  cursorQuerySchema,
  idSchema,
  postDraftSaveSchema,
  type CursorQuery,
  type CursorResult,
  type PostDetail,
  type PostDraftDetail,
  type PostDraftSaveInput,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import { DraftsService, type PostDraftSummary } from './drafts.service';

/**
 * 草稿接口。全部要求登录,且每个查询都带 `authorId`,
 * 草稿在任何情况下都不会被作者以外的人读到。
 */
@Controller('community/drafts')
export class DraftsController {
  constructor(private readonly drafts: DraftsService) {}

  /** 新建空草稿,返回 id 与初始 revision */
  @Post()
  async create(@CurrentUser() user: AuthUser): Promise<PostDraftDetail> {
    return this.drafts.create(user);
  }

  /** 我的草稿列表 */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(zodQuery(cursorQuerySchema)) query: CursorQuery,
  ): Promise<CursorResult<PostDraftSummary>> {
    return this.drafts.list(user, query);
  }

  /** 单个草稿(继续编辑用) */
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<PostDraftDetail> {
    return this.drafts.detail(user, id);
  }

  /**
   * 自动保存。带版本号写入,旧版本请求会得到 409 DRAFT_STALE,
   * 前端收到后应丢弃本次结果而不是用本地内容覆盖服务端。
   */
  @Put(':id')
  async save(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(postDraftSaveSchema)) dto: PostDraftSaveInput,
  ): Promise<PostDraftDetail> {
    return this.drafts.save(user, id, dto);
  }

  /** 草稿转发布 */
  @Post(':id/publish')
  @HttpCode(200)
  async publish(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<PostDetail> {
    return this.drafts.publish(user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<void> {
    await this.drafts.remove(user, id);
  }
}
