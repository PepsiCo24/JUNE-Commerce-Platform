import { Injectable } from '@nestjs/common';
import { PostStatus, Prisma } from '@june/db';
import {
  ERROR_CODES,
  postPublishSchema,
  type CursorResult,
  type PostDetail,
  type PostDraftDetail,
  type PostDraftSaveInput,
} from '@june/shared';
import { nanoid } from 'nanoid';

import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { encodeTimeCursor, fromPrismaCategory, parseCursor, toPrismaCategory, type TimeCursor } from './community.util';
import { PostsService } from './posts.service';

/**
 * 草稿列表项。
 * 草稿正文最大 512KB,列表里不可能把每条正文都带上,
 * 因此列表只返回标题与元信息,正文通过单条草稿接口按需拉取。
 */
export interface PostDraftSummary {
  id: string;
  title: string;
  revision: number;
  coverAssetId: string | null;
  imageCount: number;
  updatedAt: string;
}

const DRAFT_SELECT = {
  id: true,
  title: true,
  contentHtml: true,
  contentJson: true,
  coverAssetId: true,
  imageAssetIds: true,
  category: true,
  draftRevision: true,
  updatedAt: true,
} satisfies Prisma.PostSelect;

type DraftRow = Prisma.PostGetPayload<{ select: typeof DRAFT_SELECT }>;

@Injectable()
export class DraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
  ) {}

  /**
   * 新建草稿。
   * slug 此时只是占位(公开链接在发布时才生成并固定),用随机串保证唯一。
   */
  async create(user: AuthUser): Promise<PostDraftDetail> {
    const draft = await this.prisma.db.post.create({
      data: {
        authorId: user.id,
        slug: `draft-${nanoid(16)}`,
        status: PostStatus.DRAFT,
        title: '',
        contentHtml: '',
        draftRevision: 0,
      },
      select: DRAFT_SELECT,
    });

    return this.toDetail(draft);
  }

  /**
   * 自动保存。
   *
   * 自动保存请求可能乱序到达(网络抖动、重试),必须保证**旧请求不会覆盖新内容**:
   * 更新条件里带上 `draftRevision < revision`,数据库层面做一次比较并写入新版本号。
   * 命中 0 行说明服务端已有同版本或更新的内容,返回 DRAFT_STALE(409),
   * 前端据此丢弃这次保存结果,而不是把编辑器里的旧内容再写回去。
   */
  async save(user: AuthUser, draftId: string, input: PostDraftSaveInput): Promise<PostDraftDetail> {
    // 草稿同样可能被预览渲染,正文必须先清洗再落库
    const prepared = await this.posts.prepareContent(
      user.id,
      {
        contentHtml: input.contentHtml,
        imageAssetIds: input.imageAssetIds,
        coverAssetId: input.coverAssetId ?? null,
      },
      { allowEmpty: true },
    );

    const changed = await this.prisma.db.post.updateMany({
      where: {
        id: draftId,
        authorId: user.id,
        status: PostStatus.DRAFT,
        deletedAt: null,
        draftRevision: { lt: input.revision },
      },
      data: {
        title: input.title,
        contentHtml: prepared.contentHtml,
        contentJson:
          input.contentJson === undefined || input.contentJson === null
            ? Prisma.DbNull
            : (input.contentJson as Prisma.InputJsonValue),
        coverAssetId: prepared.coverAssetId,
        imageAssetIds: prepared.imageAssetIds,
        category: toPrismaCategory(input.category),
        draftRevision: input.revision,
      },
    });

    if (changed.count === 0) {
      // 区分"不是你的草稿"与"版本落后",两者的前端处理方式完全不同
      const current = await this.prisma.db.post.findFirst({
        where: { id: draftId, authorId: user.id, status: PostStatus.DRAFT, deletedAt: null },
        select: { id: true },
      });
      if (!current) throw AppException.notOwner();

      throw AppException.conflict(
        ERROR_CODES.DRAFT_STALE,
        '服务端已有更新的草稿版本,本次较旧的自动保存已被丢弃',
      );
    }

    const saved = await this.prisma.db.post.findFirstOrThrow({
      where: { id: draftId, authorId: user.id },
      select: DRAFT_SELECT,
    });
    return this.toDetail(saved);
  }

  /** 我的草稿列表。查询必须带 authorId,草稿只有作者能看到。 */
  async list(user: AuthUser, query: { cursor?: string; limit: number }): Promise<CursorResult<PostDraftSummary>> {
    const keyset = this.buildKeyset(query.cursor);

    const rows = await this.prisma.db.post.findMany({
      where: {
        AND: [{ authorId: user.id, status: PostStatus.DRAFT, deletedAt: null }, keyset],
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        title: true,
        coverAssetId: true,
        imageAssetIds: true,
        draftRevision: true,
        updatedAt: true,
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        title: row.title,
        revision: row.draftRevision,
        coverAssetId: row.coverAssetId,
        imageCount: row.imageAssetIds.length,
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeTimeCursor(last.updatedAt, last.id) : null,
      hasMore,
    };
  }

  /** 单个草稿。只允许作者访问。 */
  async detail(user: AuthUser, draftId: string): Promise<PostDraftDetail> {
    const draft = await this.prisma.db.post.findFirst({
      where: { id: draftId, authorId: user.id, status: PostStatus.DRAFT, deletedAt: null },
      select: DRAFT_SELECT,
    });
    if (!draft) throw AppException.notOwner();

    return this.toDetail(draft);
  }

  /**
   * 草稿转发布。
   * 用发布契约(postPublishSchema)重新校验草稿内容——草稿保存时标题可以为空,
   * 发布时必须满足完整规则,不能因为"已经存在于库里"就跳过校验。
   */
  async publish(user: AuthUser, draftId: string): Promise<PostDetail> {
    const draft = await this.prisma.db.post.findFirst({
      where: { id: draftId, authorId: user.id, status: PostStatus.DRAFT, deletedAt: null },
      select: DRAFT_SELECT,
    });
    if (!draft) throw AppException.notOwner();

    const parsed = postPublishSchema.safeParse({
      title: draft.title,
      contentHtml: draft.contentHtml,
      contentJson: draft.contentJson ?? undefined,
      coverAssetId: draft.coverAssetId,
      imageAssetIds: draft.imageAssetIds,
      category: fromPrismaCategory(draft.category),
    });
    if (!parsed.success) {
      throw AppException.validation(
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.') || '(root)',
          message: issue.message,
        })),
        '草稿还不满足发布要求',
      );
    }

    return this.posts.publishExisting(user, draftId, parsed.data);
  }

  /** 删除草稿(软删除)。草稿从未计入资产引用,无需调整引用计数。 */
  async remove(user: AuthUser, draftId: string): Promise<void> {
    const changed = await this.prisma.db.post.updateMany({
      where: { id: draftId, authorId: user.id, status: PostStatus.DRAFT, deletedAt: null },
      data: { status: PostStatus.DELETED, deletedAt: new Date() },
    });
    if (changed.count === 0) throw AppException.notOwner();
  }

  /** 键集游标:按 (updatedAt, id) 递减翻页 */
  private buildKeyset(cursor?: string): Prisma.PostWhereInput {
    if (!cursor) return {};
    const payload = parseCursor<TimeCursor>(cursor, ['t', 'id']);
    const at = new Date(payload.t);
    return { OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: payload.id } }] };
  }

  private toDetail(row: DraftRow): PostDraftDetail {
    return {
      id: row.id,
      title: row.title,
      contentHtml: row.contentHtml,
      contentJson: row.contentJson ?? null,
      coverAssetId: row.coverAssetId,
      imageAssetIds: row.imageAssetIds,
      category: fromPrismaCategory(row.category),
      revision: row.draftRevision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
