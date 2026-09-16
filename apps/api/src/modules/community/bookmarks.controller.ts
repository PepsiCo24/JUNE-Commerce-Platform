import { Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  bookmarkListQuerySchema,
  idSchema,
  type BookmarkListQuery,
  type CursorResult,
  type PostListItem,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import { BookmarksService, type BookmarkResult } from './bookmarks.service';

@Controller('community')
export class BookmarksController {
  constructor(private readonly bookmarks: BookmarksService) {}

  /** 我的收藏。仅本人可读。 */
  @Get('bookmarks')
  async listMine(
    @CurrentUser() user: AuthUser,
    @Query(zodQuery(bookmarkListQuerySchema)) query: BookmarkListQuery,
  ): Promise<CursorResult<PostListItem>> {
    return this.bookmarks.listMine(user, query);
  }

  @Post('posts/:id/bookmark')
  @HttpCode(200)
  async bookmark(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<BookmarkResult> {
    return this.bookmarks.bookmark(user, id);
  }

  @Delete('posts/:id/bookmark')
  @HttpCode(200)
  async unbookmark(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<BookmarkResult> {
    return this.bookmarks.unbookmark(user, id);
  }
}
