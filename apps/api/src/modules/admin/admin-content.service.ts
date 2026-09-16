import { Injectable } from '@nestjs/common';
import { CommentStatus, PostStatus, Prisma } from '@june/db';
import {
  decodeCursor,
  encodeCursor,
  ERROR_CODES,
  htmlToExcerpt,
  type CursorResult,
} from '@june/shared';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SseService } from '../events/sse.service';
import { findForeignImageSrcs, sanitizePostHtml } from '../community/html-sanitize';
import type { ClientMeta } from './admin-user.service';

export interface AdminPostListQuery {
  cursor?: string;
  limit: number;
  q?: string;
  status: 'ALL' | 'DRAFT' | 'PUBLISHED' | 'HIDDEN' | 'DELETED';
  authorId?: string;
  pinned: 'ALL' | 'PINNED' | 'NORMAL';
}

export interface AdminCommentListQuery {
  cursor?: string;
  limit: number;
  q?: string;
  postId?: string;
  status: 'ALL' | 'VISIBLE' | 'HIDDEN' | 'DELETED';
}

export interface AdminPostView {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  status: string;
  authorId: string;
  authorName: string;
  authorEmail: string;
  isPinned: boolean;
  pinnedOrder: number | null;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  publishedAt: string | null;
  updatedAt: string;
  contentEditedAt: string | null;
  hiddenAt: string | null;
  hiddenReason: string | null;
  deletedAt: string | null;
  contentHtml: string;
}

export interface AdminCommentView {
  id: string;
  postId: string;
  postTitle: string;
  postSlug: string;
  authorId: string;
  authorName: string;
  content: string;
  status: string;
  parentId: string | null;
  createdAt: string;
  hiddenAt: string | null;
  hiddenReason: string | null;
}

interface TimeCursor extends Record<string, string | number> {
  t: number;
  id: string;
}

@Injectable()
export class AdminContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sse: SseService,
  ) {}

  async listPosts(query: AdminPostListQuery): Promise<CursorResult<AdminPostView>> {
    const where: Prisma.PostWhereInput = {
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...(query.status === 'ALL'
        ? {}
        : query.status === 'DELETED'
          ? { deletedAt: { not: null } }
          : { status: query.status, deletedAt: null }),
      ...(query.pinned === 'PINNED' ? { isPinned: true } : query.pinned === 'NORMAL' ? { isPinned: false } : {}),
      ...(query.q?.trim()
        ? {
            OR: [
              { title: { contains: query.q.trim(), mode: 'insensitive' } },
              { excerpt: { contains: query.q.trim(), mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.cursor ? this.keyset(query.cursor) : {}),
    };

    const rows = await this.prisma.db.post.findMany({
      where,
      orderBy: [{ isPinned: 'desc' }, { pinnedOrder: 'asc' }, { updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: { author: { select: { displayName: true, email: true } } },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => this.toPostView(row)),
      nextCursor: hasMore && last ? encodeCursor({ t: last.updatedAt.getTime(), id: last.id }) : null,
      hasMore,
    };
  }

  async getPost(id: string): Promise<AdminPostView> {
    const row = await this.prisma.db.post.findUnique({
      where: { id },
      include: { author: { select: { displayName: true, email: true } } },
    });
    if (!row) throw AppException.notFound('帖子不存在');
    return this.toPostView(row);
  }

  async updatePost(
    actor: AuthUser,
    id: string,
    input: { title?: string; contentHtml?: string; excerpt?: string | null; reason?: string },
    meta: ClientMeta,
  ): Promise<AdminPostView> {
    const post = await this.prisma.db.post.findUnique({ where: { id } });
    if (!post) throw AppException.notFound('帖子不存在');

    const data: Prisma.PostUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.contentHtml !== undefined) {
      const assets = post.imageAssetIds.length
        ? await this.prisma.db.asset.findMany({
            where: { id: { in: post.imageAssetIds } },
            select: { objectKey: true, derivatives: true },
          })
        : [];
      const allowedImageKeys = assets.flatMap((asset) => {
        const derivatives =
          asset.derivatives && typeof asset.derivatives === 'object'
            ? (asset.derivatives as { thumb?: { key?: string }; preview?: { key?: string } })
            : {};
        return [asset.objectKey, derivatives.thumb?.key, derivatives.preview?.key].filter(
          (key): key is string => Boolean(key),
        );
      });
      const { html, rejectedImageSrcs } = sanitizePostHtml(input.contentHtml, { allowedImageKeys });
      const foreign = [...rejectedImageSrcs, ...findForeignImageSrcs(html, allowedImageKeys)];
      if (foreign.length > 0) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_FAILED,
          '正文中存在不允许的图片地址,管理员修改同样需要使用本平台资产',
        );
      }
      data.contentHtml = html;
      data.contentEditedAt = new Date();
      if (input.excerpt === undefined) data.excerpt = htmlToExcerpt(html) || null;
    }
    if (input.excerpt !== undefined) data.excerpt = input.excerpt;

    const updated = await this.prisma.db.post.update({
      where: { id },
      data,
      include: { author: { select: { displayName: true, email: true } } },
    });

    await this.audit.record({
      actor,
      action: 'post.admin.update',
      targetType: 'Post',
      targetId: id,
      diff: { title: input.title, reason: input.reason ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.sse.publishBroadcast({ type: 'post.updated', postId: id, slug: updated.slug, action: 'updated' });
    return this.toPostView(updated);
  }

  async changeVisibility(
    actor: AuthUser,
    id: string,
    input: { action: 'hide' | 'restore' | 'delete'; reason?: string },
    meta: ClientMeta,
  ): Promise<AdminPostView> {
    const post = await this.prisma.db.post.findUnique({
      where: { id },
      include: { author: { select: { displayName: true, email: true } } },
    });
    if (!post) throw AppException.notFound('帖子不存在');

    const now = new Date();
    let status = post.status;
    let hiddenAt = post.hiddenAt;
    let hiddenReason = post.hiddenReason;
    let deletedAt = post.deletedAt;
    let sseAction: 'hidden' | 'restored' | 'deleted' = 'hidden';

    if (input.action === 'hide') {
      status = PostStatus.HIDDEN;
      hiddenAt = now;
      hiddenReason = input.reason ?? '管理员隐藏';
      sseAction = 'hidden';
    } else if (input.action === 'restore') {
      if (post.deletedAt) throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '已删除的帖子不能直接恢复,请联系运维');
      status = PostStatus.PUBLISHED;
      hiddenAt = null;
      hiddenReason = null;
      sseAction = 'restored';
    } else {
      status = PostStatus.DELETED;
      deletedAt = now;
      sseAction = 'deleted';
    }

    const updated = await this.prisma.db.post.update({
      where: { id },
      data: { status, hiddenAt, hiddenReason, deletedAt },
      include: { author: { select: { displayName: true, email: true } } },
    });

    await this.audit.record({
      actor,
      action: `post.admin.${input.action}`,
      targetType: 'Post',
      targetId: id,
      diff: { reason: input.reason ?? null, from: post.status, to: status },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.sse.publishBroadcast({ type: 'post.updated', postId: id, slug: updated.slug, action: sseAction });
    return this.toPostView(updated);
  }

  async setPin(
    actor: AuthUser,
    id: string,
    input: { pinned: boolean; order?: number },
    meta: ClientMeta,
  ): Promise<AdminPostView> {
    const post = await this.prisma.db.post.findUnique({ where: { id } });
    if (!post) throw AppException.notFound('帖子不存在');

    const updated = await this.prisma.db.post.update({
      where: { id },
      data: {
        isPinned: input.pinned,
        pinnedOrder: input.pinned ? (input.order ?? 0) : null,
        pinnedAt: input.pinned ? new Date() : null,
      },
      include: { author: { select: { displayName: true, email: true } } },
    });

    await this.audit.record({
      actor,
      action: input.pinned ? 'post.admin.pin' : 'post.admin.unpin',
      targetType: 'Post',
      targetId: id,
      diff: { order: input.order ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.sse.publishBroadcast({
      type: 'post.updated',
      postId: id,
      slug: updated.slug,
      action: input.pinned ? 'pinned' : 'unpinned',
    });
    return this.toPostView(updated);
  }

  async reorderPins(
    actor: AuthUser,
    items: Array<{ postId: string; order: number }>,
    meta: ClientMeta,
  ): Promise<{ updated: number }> {
    await this.prisma.db.$transaction(
      items.map((item) =>
        this.prisma.db.post.update({
          where: { id: item.postId },
          data: { isPinned: true, pinnedOrder: item.order, pinnedAt: new Date() },
        }),
      ),
    );
    await this.audit.record({
      actor,
      action: 'post.admin.pin_reorder',
      targetType: 'Post',
      diff: { items },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { updated: items.length };
  }

  async listComments(query: AdminCommentListQuery): Promise<CursorResult<AdminCommentView>> {
    const where: Prisma.CommentWhereInput = {
      ...(query.postId ? { postId: query.postId } : {}),
      ...(query.status === 'ALL' ? {} : { status: query.status }),
      ...(query.q?.trim() ? { content: { contains: query.q.trim(), mode: 'insensitive' } } : {}),
      ...(query.cursor ? this.createdAtKeyset(query.cursor) : {}),
    };

    const rows = await this.prisma.db.comment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: {
        author: { select: { displayName: true } },
        post: { select: { title: true, slug: true } },
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        postId: row.postId,
        postTitle: row.post.title,
        postSlug: row.post.slug,
        authorId: row.authorId,
        authorName: row.author.displayName,
        content: row.content,
        status: row.status,
        parentId: row.parentId,
        createdAt: row.createdAt.toISOString(),
        hiddenAt: row.hiddenAt?.toISOString() ?? null,
        hiddenReason: row.hiddenReason,
      })),
      nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.getTime(), id: last.id }) : null,
      hasMore,
    };
  }

  async moderateComment(
    actor: AuthUser,
    id: string,
    input: { action: 'hide' | 'restore' | 'delete'; reason?: string },
    meta: ClientMeta,
  ): Promise<AdminCommentView> {
    const comment = await this.prisma.db.comment.findUnique({
      where: { id },
      include: { author: { select: { displayName: true } }, post: { select: { title: true, slug: true } } },
    });
    if (!comment) throw AppException.notFound('评论不存在');

    const now = new Date();
    let status = comment.status;
    let hiddenAt = comment.hiddenAt;
    let hiddenReason = comment.hiddenReason;
    let deletedAt = comment.deletedAt;
    let sseAction: 'hidden' | 'restored' | 'deleted' = 'hidden';
    let countDelta = 0;

    if (input.action === 'hide') {
      status = CommentStatus.HIDDEN;
      hiddenAt = now;
      hiddenReason = input.reason ?? '管理员隐藏';
      sseAction = 'hidden';
      if (comment.status === CommentStatus.VISIBLE) countDelta = -1;
    } else if (input.action === 'restore') {
      status = CommentStatus.VISIBLE;
      hiddenAt = null;
      hiddenReason = null;
      deletedAt = null;
      sseAction = 'restored';
      if (comment.status !== CommentStatus.VISIBLE) countDelta = 1;
    } else {
      status = CommentStatus.DELETED;
      deletedAt = now;
      sseAction = 'deleted';
      if (comment.status === CommentStatus.VISIBLE) countDelta = -1;
    }

    const updated = await this.prisma.db.$transaction(async (tx) => {
      const row = await tx.comment.update({
        where: { id },
        data: { status, hiddenAt, hiddenReason, deletedAt },
        include: { author: { select: { displayName: true } }, post: { select: { title: true, slug: true } } },
      });
      if (countDelta !== 0) {
        await tx.post.update({
          where: { id: comment.postId },
          data: { commentCount: { increment: countDelta } },
        });
      }
      return row;
    });

    await this.audit.record({
      actor,
      action: `comment.admin.${input.action}`,
      targetType: 'Comment',
      targetId: id,
      diff: { reason: input.reason ?? null, from: comment.status, to: status },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.sse.publishBroadcast({
      type: 'comment.updated',
      postId: comment.postId,
      commentId: id,
      action: sseAction,
    });

    return {
      id: updated.id,
      postId: updated.postId,
      postTitle: updated.post.title,
      postSlug: updated.post.slug,
      authorId: updated.authorId,
      authorName: updated.author.displayName,
      content: updated.content,
      status: updated.status,
      parentId: updated.parentId,
      createdAt: updated.createdAt.toISOString(),
      hiddenAt: updated.hiddenAt?.toISOString() ?? null,
      hiddenReason: updated.hiddenReason,
    };
  }

  private keyset(cursor: string): Prisma.PostWhereInput {
    const payload = decodeCursor<TimeCursor>(cursor);
    if (!payload) throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '分页游标无效');
    const at = new Date(payload.t);
    return { OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: payload.id } }] };
  }

  private createdAtKeyset(cursor: string): Prisma.CommentWhereInput {
    const payload = decodeCursor<TimeCursor>(cursor);
    if (!payload) throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '分页游标无效');
    const at = new Date(payload.t);
    return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: payload.id } }] };
  }

  private toPostView(row: {
    id: string;
    slug: string;
    title: string;
    excerpt: string | null;
    status: PostStatus;
    authorId: string;
    author: { displayName: string; email: string };
    isPinned: boolean;
    pinnedOrder: number | null;
    likeCount: number;
    commentCount: number;
    viewCount: number;
    publishedAt: Date | null;
    updatedAt: Date;
    contentEditedAt: Date | null;
    hiddenAt: Date | null;
    hiddenReason: string | null;
    deletedAt: Date | null;
    contentHtml: string;
  }): AdminPostView {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      status: row.status,
      authorId: row.authorId,
      authorName: row.author.displayName,
      authorEmail: row.author.email,
      isPinned: row.isPinned,
      pinnedOrder: row.pinnedOrder,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      viewCount: row.viewCount,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      contentEditedAt: row.contentEditedAt?.toISOString() ?? null,
      hiddenAt: row.hiddenAt?.toISOString() ?? null,
      hiddenReason: row.hiddenReason,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      contentHtml: row.contentHtml,
    };
  }
}
