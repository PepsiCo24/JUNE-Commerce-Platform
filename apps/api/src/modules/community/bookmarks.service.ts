import { Injectable } from '@nestjs/common';
import { PostStatus, Prisma } from '@june/db';
import {
  ERROR_CODES,
  type BookmarkListQuery,
  type PageResult,
  type PostListItem,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PostsService } from './posts.service';

export interface BookmarkResult {
  bookmarked: boolean;
}

@Injectable()
export class BookmarksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
  ) {}

  async bookmark(user: AuthUser, postId: string): Promise<BookmarkResult> {
    const post = await this.prisma.db.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED, deletedAt: null },
      select: { id: true },
    });
    if (!post) throw AppException.notFound();

    try {
      const result = await this.prisma.db.bookmark.createMany({
        data: [{ postId, userId: user.id }],
        skipDuplicates: true,
      });
      if (result.count === 0) {
        throw AppException.conflict(ERROR_CODES.ALREADY_BOOKMARKED, '你已经收藏过了');
      }
    } catch (err) {
      if (err instanceof AppException) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw AppException.conflict(ERROR_CODES.ALREADY_BOOKMARKED, '你已经收藏过了');
      }
      throw err;
    }

    return { bookmarked: true };
  }

  async unbookmark(user: AuthUser, postId: string): Promise<BookmarkResult> {
    const deleted = await this.prisma.db.bookmark.deleteMany({
      where: { postId, userId: user.id },
    });
    if (deleted.count === 0) {
      throw AppException.conflict(ERROR_CODES.NOT_BOOKMARKED, '你还没有收藏');
    }
    return { bookmarked: false };
  }

  async listMine(user: AuthUser, query: BookmarkListQuery): Promise<PageResult<PostListItem>> {
    const keyword = query.q?.trim();
    const page = query.page;
    const pageSize = query.pageSize;

    const where = {
      userId: user.id,
      ...(keyword
        ? {
            post: {
              OR: [
                { title: { contains: keyword, mode: 'insensitive' as const } },
                { excerpt: { contains: keyword, mode: 'insensitive' as const } },
                { contentHtml: { contains: keyword, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.db.bookmark.count({ where }),
      this.prisma.db.bookmark.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          createdAt: true,
          postId: true,
          post: {
            select: {
              id: true,
              slug: true,
              title: true,
              excerpt: true,
              category: true,
              authorId: true,
              status: true,
              publishedAt: true,
              likeCount: true,
              commentCount: true,
              isPinned: true,
              hotScore: true,
              updatedAt: true,
              imageAssetIds: true,
              deletedAt: true,
              coverAsset: {
                select: {
                  id: true,
                  objectKey: true,
                  visibility: true,
                  derivatives: true,
                  width: true,
                  height: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const accessibleRows = rows
      .filter(
        (row) =>
          row.post && row.post.deletedAt == null && row.post.status === PostStatus.PUBLISHED,
      )
      .map((row) => row.post!);

    const assembled = await this.posts.toListItems(accessibleRows, user);
    const byId = new Map(assembled.map((item) => [item.id, item]));

    const items: PostListItem[] = rows.map((row) => {
      const bookmarkedAt = row.createdAt.toISOString();
      const visible = byId.get(row.postId);
      if (visible) {
        return { ...visible, bookmarkedByMe: true, bookmarkedAt };
      }
      return {
        id: row.postId,
        slug: row.post?.slug ?? row.postId,
        title: '内容不可用',
        excerpt: '该帖子已隐藏、删除或不可访问',
        category: 'other',
        coverUrl: null,
        coverWidth: null,
        coverHeight: null,
        imageCount: 0,
        author: { id: 'unavailable', displayName: '—', avatarUrl: null },
        publishedAt: null,
        likeCount: 0,
        commentCount: 0,
        isPinned: false,
        likedByMe: false,
        bookmarkedByMe: true,
        status: 'DELETED',
        updatedAt: bookmarkedAt,
        unavailable: true,
        bookmarkedAt,
      };
    });

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
    };
  }
}
