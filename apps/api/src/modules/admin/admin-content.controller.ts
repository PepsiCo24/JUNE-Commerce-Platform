import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ROLE_ADMIN, ROLE_LEVEL } from '@june/db';
import {
  adminCommentActionSchema,
  adminCommentListQuerySchema,
  adminPinReorderSchema,
  adminPostListQuerySchema,
  adminPostPinSchema,
  adminPostUpdateSchema,
  adminPostVisibilitySchema,
  idSchema,
  type CursorResult,
} from '@june/shared';
import type { z } from 'zod';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import {
  AdminContentService,
  type AdminCommentView,
  type AdminPostView,
} from './admin-content.service';
import type { ClientMeta } from './admin-user.service';

type PostListQuery = z.infer<typeof adminPostListQuerySchema>;
type CommentListQuery = z.infer<typeof adminCommentListQuerySchema>;

@Controller('admin')
@MinRoleLevel(ROLE_LEVEL[ROLE_ADMIN])
export class AdminContentController {
  constructor(private readonly content: AdminContentService) {}

  @Get('posts')
  async listPosts(
    @Query(zodQuery(adminPostListQuerySchema)) query: PostListQuery,
  ): Promise<CursorResult<AdminPostView>> {
    return this.content.listPosts(query);
  }

  @Put('posts/pin-order')
  async reorder(
    @CurrentUser() actor: AuthUser,
    @Body(zodBody(adminPinReorderSchema)) dto: z.infer<typeof adminPinReorderSchema>,
    @ClientInfo() meta: ClientMeta,
  ): Promise<{ updated: number }> {
    return this.content.reorderPins(actor, dto.items, meta);
  }

  @Get('posts/:id')
  async getPost(@Param('id', zodBody(idSchema)) id: string): Promise<AdminPostView> {
    return this.content.getPost(id);
  }

  @Patch('posts/:id')
  async updatePost(
    @CurrentUser() actor: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(adminPostUpdateSchema)) dto: z.infer<typeof adminPostUpdateSchema>,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminPostView> {
    return this.content.updatePost(actor, id, dto, meta);
  }

  @Post('posts/:id/visibility')
  @HttpCode(200)
  async visibility(
    @CurrentUser() actor: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(adminPostVisibilitySchema)) dto: z.infer<typeof adminPostVisibilitySchema>,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminPostView> {
    return this.content.changeVisibility(actor, id, dto, meta);
  }

  @Post('posts/:id/pin')
  @HttpCode(200)
  async pin(
    @CurrentUser() actor: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(adminPostPinSchema)) dto: z.infer<typeof adminPostPinSchema>,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminPostView> {
    return this.content.setPin(actor, id, dto, meta);
  }

  @Get('comments')
  async listComments(
    @Query(zodQuery(adminCommentListQuerySchema)) query: CommentListQuery,
  ): Promise<CursorResult<AdminCommentView>> {
    return this.content.listComments(query);
  }

  @Post('comments/:id/action')
  @HttpCode(200)
  async commentAction(
    @CurrentUser() actor: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(adminCommentActionSchema)) dto: z.infer<typeof adminCommentActionSchema>,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminCommentView> {
    return this.content.moderateComment(actor, id, dto, meta);
  }
}
