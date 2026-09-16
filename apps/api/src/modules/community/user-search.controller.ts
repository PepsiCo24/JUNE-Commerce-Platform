import { Controller, Get, Query } from '@nestjs/common';
import {
  userSearchQuerySchema,
  type CommunityUserSummary,
  type CursorResult,
  type UserSearchQuery,
} from '@june/shared';
import { UserStatus } from '@june/db';

import { Public } from '../../common/auth/auth.decorators';
import { zodQuery } from '../../common/validation/zod-body.pipe';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AssetUrlService } from '../assets/asset-url.service';
import { encodeTimeCursor, parseCursor, type TimeCursor } from './community.util';

/**
 * 用户公开搜索。只返回昵称 / 简介 / 头像与已发布帖数,绝不暴露邮箱等私密字段。
 */
@Controller('community')
export class UserSearchController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly urls: AssetUrlService,
  ) {}

  @Public()
  @Get('users/search')
  async search(
    @Query(zodQuery(userSearchQuerySchema)) query: UserSearchQuery,
  ): Promise<CursorResult<CommunityUserSummary>> {
    const keyword = query.q.trim();
    const cursor = query.cursor ? parseCursor<TimeCursor>(query.cursor, ['t', 'id']) : null;
    const at = cursor ? new Date(cursor.t) : null;

    const rows = await this.prisma.db.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
        deletedAt: null,
        displayName: { contains: keyword, mode: 'insensitive' },
        ...(at
          ? {
              OR: [
                { createdAt: { lt: at } },
                { AND: [{ createdAt: at }, { id: { lt: cursor!.id } }] },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        displayName: true,
        bio: true,
        avatarKey: true,
        createdAt: true,
        _count: { select: { posts: { where: { status: 'PUBLISHED', deletedAt: null } } } },
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    const items: CommunityUserSummary[] = await Promise.all(
      page.map(async (user) => ({
        id: user.id,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarKey ? await this.urls.signObjectKey(user.avatarKey, true) : null,
        publishedPostCount: user._count.posts,
      })),
    );

    return {
      items,
      nextCursor: hasMore && last ? encodeTimeCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }
}
