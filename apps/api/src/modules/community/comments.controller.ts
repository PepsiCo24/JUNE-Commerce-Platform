import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  commentCreateSchema,
  commentListQuerySchema,
  idSchema,
  type CommentCreateInput,
  type CommentItem,
  type CursorQuery,
  type CursorResult,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import { CommentsService } from './comments.service';

@Controller('community')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  /** 评论列表:顶级评论游标分页,回复挂在各自父评论下 */
  @Public()
  @Get('posts/:postId/comments')
  async list(
    @Param('postId', zodBody(idSchema)) postId: string,
    @Query(zodQuery(commentListQuerySchema)) query: CursorQuery,
    @OptionalUser() user: AuthUser | null,
  ): Promise<CursorResult<CommentItem>> {
    return this.comments.list(postId, query, user);
  }

  /** 发表评论或一级回复 */
  @Post('posts/:postId/comments')
  async create(
    @CurrentUser() user: AuthUser,
    @Param('postId', zodBody(idSchema)) postId: string,
    @Body(zodBody(commentCreateSchema)) dto: CommentCreateInput,
  ): Promise<CommentItem> {
    return this.comments.create(user, postId, dto);
  }

  /** 删除自己的评论 */
  @Delete('comments/:id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<void> {
    await this.comments.remove(user, id);
  }
}
