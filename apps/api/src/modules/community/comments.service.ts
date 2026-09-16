import { Injectable } from '@nestjs/common';
import { CommentStatus, PostStatus, Prisma } from '@june/db';
import {
  ERROR_CODES,
  type CommentCreateInput,
  type CommentItem,
  type CursorQuery,
  type CursorResult,
  type PostAuthorSummary,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuthorSummaryService } from './author-summary.service';
import { encodeTimeCursor, parseCursor, type TimeCursor } from './community.util';
import { toPlainText } from './html-sanitize';

const COMMENT_SELECT = {
  id: true,
  postId: true,
  authorId: true,
  parentId: true,
  content: true,
  status: true,
  createdAt: true,
} satisfies Prisma.CommentSelect;

type CommentRow = Prisma.CommentGetPayload<{ select: typeof COMMENT_SELECT }>;

/**
 * 单次请求最多带回的回复条数。
 * 评论是两级结构,回复不单独分页,这里给一个明确上限而不是无限展开。
 */
const REPLY_FETCH_LIMIT = 500;

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authors: AuthorSummaryService,
  ) {}

  /**
   * 评论列表。顶级评论走游标分页,其回复一次性批量取回后在内存里挂到父评论下,
   * 全程两次查询(顶级 + 回复)加一次作者查询,不随评论条数增长。
   */
  async list(
    postId: string,
    query: CursorQuery,
    viewer: AuthUser | null,
  ): Promise<CursorResult<CommentItem>> {
    await this.assertPostReadable(postId);

    const tops = await this.prisma.db.comment.findMany({
      where: {
        AND: [
          { postId, parentId: null, status: CommentStatus.VISIBLE, deletedAt: null },
          this.buildKeyset(query.cursor),
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      select: COMMENT_SELECT,
    });

    const hasMore = tops.length > query.limit;
    const page = hasMore ? tops.slice(0, query.limit) : tops;
    const last = page[page.length - 1];

    const replies =
      page.length > 0
        ? await this.prisma.db.comment.findMany({
            where: {
              postId,
              parentId: { in: page.map((row) => row.id) },
              status: CommentStatus.VISIBLE,
              deletedAt: null,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: REPLY_FETCH_LIMIT,
            select: COMMENT_SELECT,
          })
        : [];

    const authors = await this.authors.loadMany([
      ...page.map((row) => row.authorId),
      ...replies.map((row) => row.authorId),
    ]);

    const parentAuthorById = new Map(page.map((row) => [row.id, row.authorId]));
    const repliesByParent = new Map<string, CommentRow[]>();
    for (const reply of replies) {
      if (!reply.parentId) continue;
      const bucket = repliesByParent.get(reply.parentId);
      if (bucket) bucket.push(reply);
      else repliesByParent.set(reply.parentId, [reply]);
    }

    const items = page.map((row) => ({
      ...this.toItem(row, authors, viewer, null),
      replies: (repliesByParent.get(row.id) ?? []).map((reply) =>
        this.toItem(
          reply,
          authors,
          viewer,
          // 一级回复的"回复 @xxx"指向父评论作者
          this.authors.resolve(authors, parentAuthorById.get(reply.parentId ?? '') ?? '').displayName,
        ),
      ),
    }));

    return {
      items,
      nextCursor: hasMore && last ? encodeTimeCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }

  /**
   * 发表评论或回复。
   *
   * - 帖子必须是已发布状态,草稿/隐藏/删除的帖子不接受评论;
   * - 回复目标必须属于同一帖子且可见,且只支持一级回复(不允许回复的回复);
   * - 评论数与评论行在同一事务里变更,保证计数不会飘。
   */
  async create(user: AuthUser, postId: string, input: CommentCreateInput): Promise<CommentItem> {
    // 评论按纯文本存储,不允许任何 HTML,渲染端按文本输出
    const content = toPlainText(input.content);
    if (!content) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '评论内容不能为空');
    }

    const created = await this.prisma.db.$transaction(async (tx) => {
      const post = await tx.post.findFirst({
        where: { id: postId, status: PostStatus.PUBLISHED, deletedAt: null },
        select: { id: true },
      });
      if (!post) throw AppException.notFound();

      if (input.parentId) {
        const parent = await tx.comment.findFirst({
          where: {
            id: input.parentId,
            postId,
            status: CommentStatus.VISIBLE,
            deletedAt: null,
          },
          select: { id: true, parentId: true },
        });
        if (!parent) throw AppException.notFound();
        if (parent.parentId) {
          throw AppException.badRequest(
            ERROR_CODES.VALIDATION_FAILED,
            '只支持对顶级评论回复,请直接回复原评论',
          );
        }
      }

      const comment = await tx.comment.create({
        data: {
          postId,
          authorId: user.id,
          parentId: input.parentId ?? null,
          content,
          status: CommentStatus.VISIBLE,
        },
        select: COMMENT_SELECT,
      });

      await tx.post.update({
        where: { id: postId },
        data: { commentCount: { increment: 1 } },
        select: { id: true },
      });

      return comment;
    });

    const authors = await this.authors.loadMany([created.authorId]);
    return this.toItem(created, authors, user, null);
  }

  /** 删除自己的评论:软删除并回退帖子的评论数 */
  async remove(user: AuthUser, commentId: string): Promise<void> {
    await this.prisma.db.$transaction(async (tx) => {
      const comment = await tx.comment.findFirst({
        where: {
          id: commentId,
          authorId: user.id,
          status: CommentStatus.VISIBLE,
          deletedAt: null,
        },
        select: { id: true, postId: true },
      });
      if (!comment) throw AppException.notOwner();

      const changed = await tx.comment.updateMany({
        where: {
          id: commentId,
          authorId: user.id,
          status: CommentStatus.VISIBLE,
          deletedAt: null,
        },
        data: { status: CommentStatus.DELETED, deletedAt: new Date() },
      });
      // 并发重复删除时只有第一次生效,避免评论数被多减
      if (changed.count === 0) throw AppException.notOwner();

      await tx.post.updateMany({
        where: { id: comment.postId, commentCount: { gt: 0 } },
        data: { commentCount: { decrement: 1 } },
      });
    });
  }

  // ---------------------------------------------------------------------------

  private async assertPostReadable(postId: string): Promise<void> {
    const post = await this.prisma.db.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED, deletedAt: null },
      select: { id: true },
    });
    if (!post) throw AppException.notFound();
  }

  private buildKeyset(cursor?: string): Prisma.CommentWhereInput {
    if (!cursor) return {};
    const payload = parseCursor<TimeCursor>(cursor, ['t', 'id']);
    const at = new Date(payload.t);
    return { OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: payload.id } }] };
  }

  private toItem(
    row: CommentRow,
    authors: Map<string, PostAuthorSummary>,
    viewer: AuthUser | null,
    replyToName: string | null,
  ): CommentItem {
    return {
      id: row.id,
      content: row.content,
      author: this.authors.resolve(authors, row.authorId),
      parentId: row.parentId,
      replyToName,
      createdAt: row.createdAt.toISOString(),
      canDelete: viewer?.id === row.authorId,
      status: row.status,
    };
  }
}
