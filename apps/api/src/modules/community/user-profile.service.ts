import { Injectable } from '@nestjs/common';
import { type PageResult, type PostListItem, type PublicUserProfile } from '@june/shared';
import { UserStatus } from '@june/db';

import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AssetUrlService } from '../assets/asset-url.service';
import { PostsService } from './posts.service';

@Injectable()
export class UserProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly urls: AssetUrlService,
    private readonly posts: PostsService,
  ) {}

  async getPublicProfile(userId: string): Promise<PublicUserProfile> {
    const user = await this.prisma.db.user.findFirst({
      where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
      select: {
        id: true,
        displayName: true,
        avatarKey: true,
        bio: true,
        location: true,
        phone: true,
        wechatId: true,
        createdAt: true,
        _count: { select: { posts: { where: { status: 'PUBLISHED', deletedAt: null } } } },
      },
    });

    if (!user) {
      throw AppException.notFound('用户不存在或已注销');
    }

    const totalLikeCount = await this.prisma.db.post.aggregate({
      where: { authorId: userId, status: 'PUBLISHED', deletedAt: null },
      _sum: { likeCount: true },
    });

    return {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarKey ? await this.urls.signObjectKey(user.avatarKey, true) : null,
      bio: user.bio,
      location: user.location,
      phone: user.phone,
      wechatId: user.wechatId,
      joinedAt: user.createdAt.toISOString(),
      stats: {
        publishedPostCount: user._count.posts,
        totalLikeCount: totalLikeCount._sum.likeCount ?? 0,
      },
    };
  }

  async listPublicPosts(
    userId: string,
    query: { page: number; pageSize: number },
  ): Promise<PageResult<PostListItem>> {
    const exists = await this.prisma.db.user.findFirst({
      where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
      select: { id: true },
    });
    if (!exists) {
      throw AppException.notFound('用户不存在或已注销');
    }

    return this.posts.list(
      {
        page: query.page,
        pageSize: query.pageSize,
        sort: 'latest',
        category: 'all',
        authorId: userId,
        mine: false,
      },
      null,
    );
  }
}
