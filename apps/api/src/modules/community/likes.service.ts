import { Injectable } from '@nestjs/common';
import { PostStatus, Prisma } from '@june/db';
import { ERROR_CODES } from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface LikeResult {
  liked: boolean;
  likeCount: number;
}

/**
 * 点赞。
 *
 * 防重复完全依赖数据库的 `@@unique([postId, userId])`:
 * "先查有没有点过、再插入"在并发下必然出现双写,唯一约束才是唯一可靠的闸门。
 * 点赞行与 `likeCount` 在同一事务内变更,保证计数与实际点赞行数始终一致。
 */
@Injectable()
export class LikesService {
  constructor(private readonly prisma: PrismaService) {}

  async like(user: AuthUser, postId: string): Promise<LikeResult> {
    return this.prisma.db.$transaction(async (tx) => {
      const post = await tx.post.findFirst({
        where: { id: postId, status: PostStatus.PUBLISHED, deletedAt: null },
        select: { id: true },
      });
      if (!post) throw AppException.notFound();

      let inserted = 0;
      try {
        const result = await tx.like.createMany({
          data: [{ postId, userId: user.id }],
          skipDuplicates: true,
        });
        inserted = result.count;
      } catch (err) {
        // 兜底:即使某些驱动没有走 skipDuplicates,也按唯一约束冲突处理
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          inserted = 0;
        } else {
          throw err;
        }
      }

      if (inserted === 0) {
        throw AppException.conflict(ERROR_CODES.ALREADY_LIKED, '你已经点过赞了');
      }

      const updated = await tx.post.update({
        where: { id: postId },
        data: { likeCount: { increment: 1 } },
        select: { likeCount: true },
      });

      return { liked: true, likeCount: updated.likeCount };
    });
  }

  /** 取消点赞。只有真的删掉了点赞行才递减计数。 */
  async unlike(user: AuthUser, postId: string): Promise<LikeResult> {
    return this.prisma.db.$transaction(async (tx) => {
      const deleted = await tx.like.deleteMany({ where: { postId, userId: user.id } });
      if (deleted.count === 0) {
        throw AppException.conflict(ERROR_CODES.NOT_LIKED, '你还没有点赞');
      }

      // likeCount > 0 的条件避免历史数据异常时把计数减成负数
      await tx.post.updateMany({
        where: { id: postId, likeCount: { gt: 0 } },
        data: { likeCount: { decrement: 1 } },
      });

      const post = await tx.post.findFirst({ where: { id: postId }, select: { likeCount: true } });
      return { liked: false, likeCount: post?.likeCount ?? 0 };
    });
  }
}
