import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  idSchema,
  myPostListQuerySchema,
  postListQuerySchema,
  postPublishSchema,
  type CursorResult,
  type PostDetail,
  type PostListItem,
  type PostListQuery,
  type PostPublishInput,
} from '@june/shared';
import { z } from 'zod';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import { PostsService } from './posts.service';

/** slug 允许中文与短横线,长度受 buildPostSlug 约束 */
const slugSchema = z.string().trim().min(1).max(120);

type MyPostListQueryInput = z.infer<typeof myPostListQuerySchema>;

/**
 * 社区帖子接口。
 * 读接口对游客开放(仍会解析会话,用于标记 likedByMe 与作者可见性),
 * 写接口一律要求登录并带 CSRF 头。
 */
@Controller('community')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  /** 帖子大厅:置顶优先,其余按 latest / hot 排序,游标分页 */
  @Public()
  @Get('posts')
  async list(
    @Query(zodQuery(postListQuerySchema)) query: PostListQuery,
    @OptionalUser() user: AuthUser | null,
  ): Promise<CursorResult<PostListItem>> {
    return this.posts.list(query, user);
  }

  /** 我的帖子(含草稿与被隐藏的帖子) */
  @Get('my/posts')
  async listMine(
    @CurrentUser() user: AuthUser,
    @Query(zodQuery(myPostListQuerySchema)) query: MyPostListQueryInput,
  ): Promise<CursorResult<PostListItem>> {
    return this.posts.listMine(user, query);
  }

  /** 帖子详情。草稿仅作者可见,隐藏/删除的帖子立即拒绝。 */
  @Public()
  @Get('posts/:slug')
  async detail(
    @Param('slug', zodBody(slugSchema)) slug: string,
    @OptionalUser() user: AuthUser | null,
    @ClientInfo() meta: { ip: string | null; userAgent: string | null },
  ): Promise<PostDetail> {
    return this.posts.detailBySlug(slug, user, { ip: meta.ip });
  }

  /** 发布新帖子 */
  @Post('posts')
  async publish(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(postPublishSchema)) dto: PostPublishInput,
  ): Promise<PostDetail> {
    return this.posts.publish(user, dto);
  }

  /** 编辑已发布的帖子:slug 不变,记录"编辑于" */
  @Patch('posts/:id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(postPublishSchema)) dto: PostPublishInput,
  ): Promise<PostDetail> {
    return this.posts.update(user, id, dto);
  }

  /** 软删除自己的帖子 */
  @Delete('posts/:id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<void> {
    await this.posts.remove(user, id);
  }
}
