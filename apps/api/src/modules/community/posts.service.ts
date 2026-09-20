import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AssetKind, PostStatus, Prisma } from '@june/db';
import {
  buildPostSlug,
  computeHotScore,
  ERROR_CODES,
  htmlToExcerpt,
  type PageResult,
  type PostDetail,
  type PostListItem,
  type PostListQuery,
  type PostPublishInput,
} from '@june/shared';
import { nanoid } from 'nanoid';

import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { AssetsService } from '../assets/assets.service';
import { AssetUrlService } from '../assets/asset-url.service';
import { AuthorSummaryService } from './author-summary.service';
import {
  buildPostPublicUrl,
  fromPrismaCategory,
  toPrismaCategory,
} from './community.util';
import {
  findForeignImageSrcs,
  isEmptyPostHtml,
  sanitizePostHtml,
} from './html-sanitize';

/** 我的帖子列表查询(schema 在 @june/shared,这里只声明形状) */
export interface MyPostListQuery {
  page: number;
  pageSize: number;
  status: 'ALL' | 'DRAFT' | 'PUBLISHED' | 'HIDDEN';
  q?: string;
}

const COVER_SELECT = {
  id: true,
  objectKey: true,
  visibility: true,
  derivatives: true,
  width: true,
  height: true,
} satisfies Prisma.AssetSelect;

const POST_LIST_SELECT = {
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
  coverAsset: { select: COVER_SELECT },
} satisfies Prisma.PostSelect;


const POST_DETAIL_SELECT = {
  ...POST_LIST_SELECT,
  contentHtml: true,
  imageAssetIds: true,
  coverAssetId: true,
  contentEditedAt: true,
  viewCount: true,
  deletedAt: true,
} satisfies Prisma.PostSelect;

type PostListRow = Prisma.PostGetPayload<{ select: typeof POST_LIST_SELECT }>;
type PostDetailRow = Prisma.PostGetPayload<{ select: typeof POST_DETAIL_SELECT }>;

/** 首屏一次性带出的置顶帖上限,避免置顶被滥用后首屏无限膨胀 */
const PINNED_LIMIT = 10;
/** 同一访客对同一帖子的浏览量计数去抖窗口 */
const VIEW_DEDUPE_MS = 10 * 60 * 1000;

/** 清洗与校验之后、可以落库的正文数据 */
interface PreparedContent {
  contentHtml: string;
  excerpt: string | null;
  imageAssetIds: string[];
  coverAssetId: string | null;
  /** 正文图片 + 封面去重后的资产 id,用于引用计数 */
  refAssetIds: string[];
}

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly assets: AssetsService,
    private readonly urls: AssetUrlService,
    private readonly authors: AuthorSummaryService,
  ) {}

  // ---------------------------------------------------------------------------
  // 读:帖子大厅 / 详情 / 我的帖子
  // ---------------------------------------------------------------------------

  /**
   * 帖子大厅。
   *
   * 排序:置顶优先(仅首页且无搜索词时);组内按 latest / most_liked / most_commented / hot。
   * 搜索结果必须先满足查询条件,不插入无关置顶帖。
   * 分页为页码制,状态由前端写进 URL(?page=)。
   */
  async list(query: PostListQuery, viewer: AuthUser | null): Promise<PageResult<PostListItem>> {
    if (query.mine && !viewer) throw AppException.unauthenticated();

    const searching = Boolean(query.q?.trim());
    const categoryFilter =
      query.category && query.category !== 'all'
        ? { category: toPrismaCategory(query.category) }
        : {};
    const base: Prisma.PostWhereInput = {
      status: PostStatus.PUBLISHED,
      deletedAt: null,
      ...(query.mine && viewer ? { authorId: viewer.id } : {}),
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...categoryFilter,
      ...this.buildSearchWhere(query.q),
    };

    const sortOrderBy = this.buildSortOrderBy(query.sort);
    const page = query.page;
    const pageSize = query.pageSize;

    // 置顶只在大厅首页、非搜索场景展示;搜索与个人主页不插无关置顶
    const showPinned = page === 1 && !searching && !query.authorId && !query.mine;
    const pinned = showPinned
      ? await this.prisma.db.post.findMany({
          where: { AND: [base, { isPinned: true }] },
          orderBy: [{ pinnedOrder: 'asc' }, ...sortOrderBy],
          take: PINNED_LIMIT,
          select: POST_LIST_SELECT,
        })
      : [];

    const normalWhere: Prisma.PostWhereInput = {
      AND: [base, searching ? {} : { isPinned: false }],
    };

    const [total, rows] = await Promise.all([
      this.prisma.db.post.count({ where: normalWhere }),
      this.prisma.db.post.findMany({
        where: normalWhere,
        orderBy: sortOrderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: POST_LIST_SELECT,
      }),
    ]);

    return {
      items: await this.toListItems([...pinned, ...rows], viewer),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
    };
  }

  /** 我的帖子(含草稿与被隐藏的帖子,不含已删除) */
  async listMine(user: AuthUser, query: MyPostListQuery): Promise<PageResult<PostListItem>> {
    const where: Prisma.PostWhereInput = {
      authorId: user.id,
      deletedAt: null,
      status:
        query.status === 'ALL'
          ? { in: [PostStatus.DRAFT, PostStatus.PUBLISHED, PostStatus.HIDDEN] }
          : PostStatus[query.status],
      ...this.buildSearchWhere(query.q),
    };

    const page = query.page;
    const pageSize = query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.db.post.count({ where }),
      this.prisma.db.post.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: POST_LIST_SELECT,
      }),
    ]);

    return {
      items: await this.toListItems(rows, user),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
    };
  }

  /**
   * 帖子详情(公开链接)。
   *
   * 可见性判定顺序固定:已删除 → 一律 404;被隐藏 → 非作者 403(POST_HIDDEN);
   * 未发布 → 非作者 404(POST_NOT_PUBLISHED),作者本人可以预览自己的草稿。
   */
  async detailBySlug(
    slug: string,
    viewer: AuthUser | null,
    client: { ip: string | null },
  ): Promise<PostDetail> {
    const post = await this.prisma.db.post.findFirst({
      where: { slug },
      select: POST_DETAIL_SELECT,
    });
    if (!post || post.deletedAt || post.status === PostStatus.DELETED) {
      throw AppException.notFound();
    }

    const isAuthor = viewer?.id === post.authorId;
    if (post.status === PostStatus.HIDDEN && !isAuthor) {
      throw AppException.forbidden(ERROR_CODES.POST_HIDDEN);
    }
    if (post.status === PostStatus.DRAFT && !isAuthor) {
      // 不向他人暴露"这个链接确实存在一篇草稿",按 404 语义返回
      throw new AppException(ERROR_CODES.POST_NOT_PUBLISHED, HttpStatus.NOT_FOUND, '该内容尚未发布');
    }

    const viewCount =
      post.status === PostStatus.PUBLISHED
        ? await this.countView(post.id, viewer?.id ?? null, client.ip, post.viewCount)
        : post.viewCount;

    return this.toDetail({ ...post, viewCount }, viewer);
  }

  // ---------------------------------------------------------------------------
  // 写:发布 / 编辑 / 删除
  // ---------------------------------------------------------------------------

  /** 发布新帖子 */
  async publish(user: AuthUser, input: PostPublishInput): Promise<PostDetail> {
    const prepared = await this.prepareContent(user.id, input);
    const publishedAt = new Date();
    const slug = buildPostSlug(input.title, nanoid(8));

    // 引用计数先加后写:写库失败只会让计数偏大(资产暂时无法被回收),
    // 而"先写库后加计数"一旦失败会让在用图片被当成孤儿清理掉,后果严重得多。
    await this.assets.addRefs(prepared.refAssetIds, 1);

    const post = await this.prisma.db.$transaction(async (tx) => {
      return tx.post.create({
        data: {
          authorId: user.id,
          slug,
          status: PostStatus.PUBLISHED,
          title: input.title,
          contentHtml: prepared.contentHtml,
          contentJson: this.toJsonInput(input.contentJson),
          excerpt: prepared.excerpt,
          coverAssetId: prepared.coverAssetId,
          imageAssetIds: prepared.imageAssetIds,
          publishedAt,
          category: toPrismaCategory(input.category),
          hotScore: computeHotScore({
            likeCount: 0,
            commentCount: 0,
            viewCount: 0,
            publishedAt,
            now: publishedAt,
          }),
        },
        select: POST_DETAIL_SELECT,
      });
    });

    return this.toDetail(post, user);
  }

  /**
   * 把自己的草稿转为已发布。发布时生成 slug 并固定,之后编辑标题不再改变公开链接。
   * 校验与清洗完全复用发布路径。
   */
  async publishExisting(
    user: AuthUser,
    postId: string,
    input: PostPublishInput,
  ): Promise<PostDetail> {
    const prepared = await this.prepareContent(user.id, input);
    const publishedAt = new Date();
    const slug = buildPostSlug(input.title, nanoid(8));

    // 先做一次归属与状态检查,避免为一篇不属于自己的草稿去动引用计数
    const draft = await this.prisma.db.post.findFirst({
      where: { id: postId, authorId: user.id, status: PostStatus.DRAFT, deletedAt: null },
      select: { id: true },
    });
    if (!draft) throw AppException.notOwner();

    await this.assets.addRefs(prepared.refAssetIds, 1);

    const post = await this.prisma.db.$transaction(async (tx) => {
      const changed = await tx.post.updateMany({
        where: { id: postId, authorId: user.id, status: PostStatus.DRAFT, deletedAt: null },
        data: {
          slug,
          status: PostStatus.PUBLISHED,
          title: input.title,
          contentHtml: prepared.contentHtml,
          contentJson: this.toJsonInput(input.contentJson),
          excerpt: prepared.excerpt,
          coverAssetId: prepared.coverAssetId,
          imageAssetIds: prepared.imageAssetIds,
          publishedAt,
          category: toPrismaCategory(input.category),
          hotScore: computeHotScore({
            likeCount: 0,
            commentCount: 0,
            viewCount: 0,
            publishedAt,
            now: publishedAt,
          }),
        },
      });
      // 并发发布同一份草稿时只有第一次会命中,其余直接回滚
      if (changed.count === 0) throw AppException.notOwner();

      return tx.post.findFirstOrThrow({ where: { id: postId }, select: POST_DETAIL_SELECT });
    });

    return this.toDetail(post, user);
  }

  /** 编辑已发布(或被隐藏)的帖子。slug 不变,记录内容编辑时间。 */
  async update(user: AuthUser, postId: string, input: PostPublishInput): Promise<PostDetail> {
    const current = await this.prisma.db.post.findFirst({
      where: {
        id: postId,
        authorId: user.id,
        deletedAt: null,
        status: { in: [PostStatus.PUBLISHED, PostStatus.HIDDEN] },
      },
      select: { id: true, imageAssetIds: true, coverAssetId: true },
    });
    if (!current) throw AppException.notOwner();

    const prepared = await this.prepareContent(user.id, input);

    const before = [...new Set([...current.imageAssetIds, ...(current.coverAssetId ? [current.coverAssetId] : [])])];
    const added = prepared.refAssetIds.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !prepared.refAssetIds.includes(id));

    // 新增图片先 +1(失败方向安全),移除图片等写库成功后再 -1
    await this.assets.addRefs(added, 1);

    const post = await this.prisma.db.$transaction(async (tx) => {
      const changed = await tx.post.updateMany({
        where: {
          id: postId,
          authorId: user.id,
          deletedAt: null,
          status: { in: [PostStatus.PUBLISHED, PostStatus.HIDDEN] },
        },
        data: {
          title: input.title,
          contentHtml: prepared.contentHtml,
          contentJson: this.toJsonInput(input.contentJson),
          excerpt: prepared.excerpt,
          coverAssetId: prepared.coverAssetId,
          imageAssetIds: prepared.imageAssetIds,
          category: toPrismaCategory(input.category),
          contentEditedAt: new Date(),
        },
      });
      if (changed.count === 0) throw AppException.notOwner();

      return tx.post.findFirstOrThrow({ where: { id: postId }, select: POST_DETAIL_SELECT });
    });

    await this.assets.addRefs(removed, -1);

    return this.toDetail(post, user);
  }

  /** 软删除自己的帖子。图片引用计数在删除成功后回退。 */
  async remove(user: AuthUser, postId: string): Promise<void> {
    const post = await this.prisma.db.post.findFirst({
      where: {
        id: postId,
        authorId: user.id,
        deletedAt: null,
        status: { in: [PostStatus.DRAFT, PostStatus.PUBLISHED, PostStatus.HIDDEN] },
      },
      select: { id: true, status: true, imageAssetIds: true, coverAssetId: true },
    });
    if (!post) throw AppException.notOwner();

    await this.prisma.db.$transaction(async (tx) => {
      const changed = await tx.post.updateMany({
        where: { id: postId, authorId: user.id, deletedAt: null },
        data: { status: PostStatus.DELETED, deletedAt: new Date() },
      });
      if (changed.count === 0) throw AppException.notOwner();
    });

    // 草稿从未加过引用计数,只有已发布过的帖子需要回退
    if (post.status !== PostStatus.DRAFT) {
      const refIds = [...new Set([...post.imageAssetIds, ...(post.coverAssetId ? [post.coverAssetId] : [])])];
      await this.assets.addRefs(refIds, -1);
    }
  }

  // ---------------------------------------------------------------------------
  // 内容清洗与校验(发布 / 编辑 / 草稿共用)
  // ---------------------------------------------------------------------------

  /**
   * 校验图片归属 + 清洗正文 HTML。
   *
   * 正文里的每一张图片都必须落在本次提交的 `imageAssetIds` 对应的对象键上:
   * 先用白名单清洗,再对清洗结果做一次独立的外链扫描,两道都通过才允许落库。
   */
  async prepareContent(
    userId: string,
    input: {
      contentHtml: string;
      imageAssetIds: string[];
      coverAssetId?: string | null;
      excerpt?: string;
    },
    options: { allowEmpty?: boolean } = {},
  ): Promise<PreparedContent> {
    const imageAssetIds = [...new Set(input.imageAssetIds)];
    const coverAssetId = input.coverAssetId ?? null;

    // 归属校验:只能引用自己的、已确认可用的帖子图片
    const images = await this.assets.assertOwnedActive(userId, imageAssetIds, [AssetKind.POST_IMAGE]);
    if (coverAssetId) {
      await this.assets.assertOwnedActive(userId, [coverAssetId], [AssetKind.POST_IMAGE]);
    }

    const allowedImageKeys = images.flatMap((asset) => {
      const derivatives = this.urls.parseDerivatives(asset);
      return [asset.objectKey, derivatives.thumb?.key, derivatives.preview?.key].filter(
        (key): key is string => Boolean(key),
      );
    });

    const { html, rejectedImageSrcs } = sanitizePostHtml(input.contentHtml, { allowedImageKeys });
    const foreign = [...rejectedImageSrcs, ...findForeignImageSrcs(html, allowedImageKeys)];
    if (foreign.length > 0) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        '正文中存在非本平台的图片,请先上传图片再插入正文',
        { details: [{ path: 'contentHtml', message: `不被允许的图片地址共 ${foreign.length} 处` }] },
      );
    }

    if (!options.allowEmpty && isEmptyPostHtml(html)) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '正文不能为空');
    }

    const excerpt = input.excerpt?.trim() ? input.excerpt.trim() : htmlToExcerpt(html) || null;

    return {
      contentHtml: html,
      excerpt,
      imageAssetIds,
      coverAssetId,
      refAssetIds: [...new Set([...imageAssetIds, ...(coverAssetId ? [coverAssetId] : [])])],
    };
  }

  // ---------------------------------------------------------------------------
  // 组装
  // ---------------------------------------------------------------------------

  /**
   * 批量组装列表项:作者、点赞、收藏状态一次取回,杜绝 N+1。
   * 收藏列表等外部模块也会复用。
   */
  async toListItems(rows: PostListRow[], viewer: AuthUser | null): Promise<PostListItem[]> {
    if (rows.length === 0) return [];

    const postIds = rows.map((row) => row.id);
    const [authors, likedIds, bookmarkedIds] = await Promise.all([
      this.authors.loadMany(rows.map((row) => row.authorId)),
      this.loadLikedPostIds(postIds, viewer?.id ?? null),
      this.loadBookmarkedPostIds(postIds, viewer?.id ?? null),
    ]);

    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        category: fromPrismaCategory(row.category),
        coverUrl: row.coverAsset ? await this.urls.thumbUrl(row.coverAsset) : null,
        coverWidth: row.coverAsset?.width ?? null,
        coverHeight: row.coverAsset?.height ?? null,
        imageCount: (() => {
          const ids = new Set(row.imageAssetIds ?? []);
          if (row.coverAsset?.id) ids.add(row.coverAsset.id);
          return ids.size;
        })(),
        author: this.authors.resolve(authors, row.authorId),
        publishedAt: row.publishedAt?.toISOString() ?? null,
        likeCount: row.likeCount,
        commentCount: row.commentCount,
        isPinned: row.isPinned,
        likedByMe: likedIds.has(row.id),
        bookmarkedByMe: bookmarkedIds.has(row.id),
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
      })),
    );
  }

  private async toDetail(row: PostDetailRow, viewer: AuthUser | null): Promise<PostDetail> {
    const [base] = await this.toListItems([row], viewer);
    if (!base) throw AppException.notFound();

    const isAuthor = viewer?.id === row.authorId;

    const assets =
      row.imageAssetIds.length > 0
        ? await this.prisma.db.asset.findMany({
            where: { id: { in: row.imageAssetIds } },
            select: COVER_SELECT,
          })
        : [];
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));

    const images = await Promise.all(
      row.imageAssetIds
        .map((assetId) => assetById.get(assetId))
        .filter((asset): asset is (typeof assets)[number] => Boolean(asset))
        .map(async (asset) => ({
          assetId: asset.id,
          url: await this.urls.signObjectKey(asset.objectKey, asset.visibility === 'PUBLIC'),
          // 详情页读 preview:带上宽高让前端先占位,避免图片加载时的跳动
          previewUrl: await this.urls.previewUrl(asset),
          width: asset.width,
          height: asset.height,
        })),
    );

    return {
      ...base,
      coverUrl: row.coverAsset ? await this.urls.previewUrl(row.coverAsset) : null,
      contentHtml: row.contentHtml,
      images,
      contentEditedAt: row.contentEditedAt?.toISOString() ?? null,
      viewCount: row.viewCount,
      canEdit: isAuthor,
      canDelete: isAuthor,
      shareUrl:
        row.status === PostStatus.PUBLISHED
          ? buildPostPublicUrl(this.env.PUBLIC_WEB_ORIGIN, row.slug)
          : null,
    };
  }

  /** 一次批量查询当前用户在这批帖子上的点赞,避免逐条判断 */
  private async loadLikedPostIds(postIds: string[], userId: string | null): Promise<Set<string>> {
    if (!userId || postIds.length === 0) return new Set();

    const likes = await this.prisma.db.like.findMany({
      where: { postId: { in: postIds }, userId },
      select: { postId: true },
    });
    return new Set(likes.map((like) => like.postId));
  }

  private async loadBookmarkedPostIds(postIds: string[], userId: string | null): Promise<Set<string>> {
    if (!userId || postIds.length === 0) return new Set();

    const rows = await this.prisma.db.bookmark.findMany({
      where: { postId: { in: postIds }, userId },
      select: { postId: true },
    });
    return new Set(rows.map((row) => row.postId));
  }

  // ---------------------------------------------------------------------------
  // 细节
  // ---------------------------------------------------------------------------

  private buildSearchWhere(q?: string): Prisma.PostWhereInput {
    const keyword = q?.trim();
    if (!keyword) return {};
    return {
      OR: [
        { title: { contains: keyword, mode: 'insensitive' } },
        { excerpt: { contains: keyword, mode: 'insensitive' } },
        { contentHtml: { contains: keyword, mode: 'insensitive' } },
        { author: { displayName: { contains: keyword, mode: 'insensitive' } } },
      ],
    };
  }

  private buildSortOrderBy(sort: PostListQuery['sort']): Prisma.PostOrderByWithRelationInput[] {
    switch (sort) {
      case 'most_liked':
        return [{ likeCount: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }];
      case 'most_commented':
        return [{ commentCount: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }];
      case 'hot':
        return [{ hotScore: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }];
      case 'latest':
      default:
        return [{ publishedAt: 'desc' }, { id: 'desc' }];
    }
  }

  /**
   * 浏览量自增去抖:同一用户(未登录时按 IP)对同一帖子 10 分钟内只计一次。
   * 用 Redis 的 SET NX 抢占窗口,抢不到就不计数;Redis 故障时宁可少计也不重复计。
   */
  private async countView(
    postId: string,
    userId: string | null,
    ip: string | null,
    currentCount: number,
  ): Promise<number> {
    const viewer = userId ?? (ip ? `ip:${ip}` : null);
    if (!viewer) return currentCount;

    try {
      const token = await this.redis.acquireLock(`community:view:${postId}:${viewer}`, VIEW_DEDUPE_MS);
      if (!token) return currentCount;

      const updated = await this.prisma.db.post.update({
        where: { id: postId },
        data: { viewCount: { increment: 1 } },
        select: { viewCount: true },
      });
      return updated.viewCount;
    } catch (err) {
      this.logger.warn(`浏览量计数失败 post=${postId}: ${(err as Error).message}`);
      return currentCount;
    }
  }

  /** 编辑器 JSON:未提供时写入数据库 NULL,而不是 JSON 的 null 字面量 */
  private toJsonInput(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    if (value === undefined || value === null) return Prisma.DbNull;
    return value as Prisma.InputJsonValue;
  }
}
