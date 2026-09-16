import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  ROLE_ADMIN,
  ROLE_LEVEL,
  ROLE_SUPER_ADMIN,
  UserStatus,
  type RoleSlug,
} from '@june/db';
import {
  decodeCursor,
  encodeCursor,
  ERROR_CODES,
  type AdminUserSummary,
  type CursorQuery,
  type PageResult,
} from '@june/shared';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SessionService } from '../auth/session.service';
import type {
  AdminProductSummaryView,
  AdminShopCredentialView,
  AdminShopDetailView,
  AdminUserDetailView,
} from './admin.types';

/** 与 env `DEFAULT_STORAGE_QUOTA_BYTES` 默认值一致(5 GiB)。单元测试不加载完整 .env。 */
const DEFAULT_STORAGE_QUOTA_BYTES = 5 * 1024 ** 3;

/** 与 `@june/shared` 的 adminUserListQuerySchema 推断结果一致 */
export interface AdminUserListQuery {
  page: number;
  pageSize: number;
  q?: string;
  status: 'ALL' | 'ACTIVE' | 'DISABLED';
  role: 'ALL' | 'user' | 'admin' | 'super_admin';
  sort: 'created_desc' | 'created_asc' | 'active_desc';
}

export interface AdminUserStatusInput {
  status: 'ACTIVE' | 'DISABLED';
  reason?: string;
}

export interface AdminUserRoleInput {
  roles: Array<'user' | 'admin' | 'super_admin'>;
}

/** 与 `@june/shared` 的 adminCreateAdminSchema 一致 */
export interface AdminCreateAdminInput {
  email: string;
  password: string;
  displayName: string;
  role: 'admin' | 'super_admin';
}

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * 店铺凭据的安全投影。
 *
 * **规则(不可放宽):管理员既看不到用户店铺密码的明文,也拿不到密文。**
 * 因此这里用 `select` 白名单,只取 { id, purpose, account, loginUrl, note },
 * `passwordCipher` / `passwordIv` / `passwordTag` / `keyVersion` **根本不会从数据库读出**,
 * 不存在"取出来了但忘记删字段"的风险。解密接口(credential.reveal)只对店铺 owner 开放,
 * 且需要 ReauthGuard 通过,管理站没有任何入口。
 */
const CREDENTIAL_SAFE_SELECT = {
  id: true,
  purpose: true,
  account: true,
  loginUrl: true,
  note: true,
} as const satisfies Prisma.ShopCredentialSelect;

interface ListCursor extends Record<string, string | number> {
  createdAt: string;
  id: string;
}

/**
 * 事务客户端类型。
 * `PrismaService.db` 是经 `$extends` 包装后的客户端,其事务回调参数类型与原生
 * `PrismaClient` 不同,因此直接从 `$transaction` 的回调签名推导,避免手写导致不匹配。
 */
type AdminTransactionClient = Parameters<Parameters<PrismaService['db']['$transaction']>[0]>[0];

@Injectable()
export class AdminUserService {
  private readonly logger = new Logger(AdminUserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly crypto: CryptoService,
  ) {}

  // ---------------------------------------------------------------------------
  // 列表与详情
  // ---------------------------------------------------------------------------

  /**
   * 用户列表。
   *
   * 分页口径按 `@june/shared` 的 `adminUserListQuerySchema`(页码分页,默认 20 / 上限 100),
   * 契约是唯一来源,这里不另造一套。搜索对 email 与 displayName 做大小写不敏感匹配。
   *
   * 防 N+1:先取本页用户 id,再用 4 次 groupBy + 1 次 storageUsage 批量补齐统计,
   * 不在循环里逐个查询。
   */
  async list(query: AdminUserListQuery): Promise<PageResult<AdminUserSummary>> {
    const where = this.buildListWhere(query);

    const [total, users] = await Promise.all([
      this.prisma.db.user.count({ where }),
      this.prisma.db.user.findMany({
        where,
        orderBy: this.buildListOrder(query.sort),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          lastActiveAt: true,
          roles: { select: { role: { select: { slug: true } } } },
        },
      }),
    ]);

    const ids = users.map((u) => u.id);
    const stats = await this.loadCounters(ids);

    return {
      items: users.map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        roles: user.roles.map((r) => r.role.slug),
        shopCount: stats.shops.get(user.id) ?? 0,
        productCount: stats.products.get(user.id) ?? 0,
        postCount: stats.posts.get(user.id) ?? 0,
        taskCount: stats.tasks.get(user.id) ?? 0,
        storageBytes: stats.storage.get(user.id) ?? '0',
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  private buildListWhere(query: AdminUserListQuery): Prisma.UserWhereInput {
    const keyword = query.q?.trim();
    return {
      deletedAt: null,
      ...(query.status === 'ALL' ? {} : { status: query.status as UserStatus }),
      ...(query.role === 'ALL' ? {} : { roles: { some: { role: { slug: query.role } } } }),
      ...(keyword
        ? {
            OR: [
              { email: { contains: keyword, mode: 'insensitive' } },
              { displayName: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  private buildListOrder(sort: AdminUserListQuery['sort']): Prisma.UserOrderByWithRelationInput[] {
    if (sort === 'created_asc') return [{ createdAt: 'asc' }, { id: 'asc' }];
    // 从未活跃的账号排在最后,而不是因为 NULL 排序规则跑到最前面
    if (sort === 'active_desc') {
      return [{ lastActiveAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
    }
    return [{ createdAt: 'desc' }, { id: 'desc' }];
  }

  /** 批量补齐列表统计,避免逐行查询 */
  private async loadCounters(ids: string[]): Promise<{
    shops: Map<string, number>;
    products: Map<string, number>;
    posts: Map<string, number>;
    tasks: Map<string, number>;
    storage: Map<string, string>;
  }> {
    const empty = {
      shops: new Map<string, number>(),
      products: new Map<string, number>(),
      posts: new Map<string, number>(),
      tasks: new Map<string, number>(),
      storage: new Map<string, string>(),
    };
    if (ids.length === 0) return empty;

    const [shops, products, posts, tasks, usages] = await Promise.all([
      this.prisma.db.shop.groupBy({
        by: ['ownerId'],
        where: { ownerId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.db.product.groupBy({
        by: ['ownerId'],
        where: { ownerId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.db.post.groupBy({
        by: ['authorId'],
        where: { authorId: { in: ids }, deletedAt: null, status: { not: 'DELETED' } },
        _count: { _all: true },
      }),
      this.prisma.db.generationTask.groupBy({
        by: ['userId'],
        where: { userId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.db.storageUsage.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, bytesUsed: true },
      }),
    ]);

    for (const row of shops) empty.shops.set(row.ownerId, row._count._all);
    for (const row of products) empty.products.set(row.ownerId, row._count._all);
    for (const row of posts) empty.posts.set(row.authorId, row._count._all);
    for (const row of tasks) empty.tasks.set(row.userId, row._count._all);
    for (const row of usages) empty.storage.set(row.userId, row.bytesUsed.toString());

    return empty;
  }

  /**
   * 用户详情:资料、角色、会话数、最后活跃、存储用量、店铺(含主子关系)与商品统计。
   * 店铺列表只给业务字段与凭据条数,凭据明细走下钻接口(同样不含密码)。
   */
  async detail(userId: string): Promise<AdminUserDetailView> {
    const user = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        bio: true,
        sessionEpoch: true,
        passwordChangedAt: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        lastActiveAt: true,
        roles: { select: { role: { select: { slug: true } } } },
        storageUsage: { select: { bytesUsed: true, quotaBytes: true, recycledBytes: true } },
      },
    });
    if (!user) throw AppException.notFound('用户不存在或已删除');

    const shops = await this.prisma.db.shop.findMany({
      where: { ownerId: userId, deletedAt: null },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        platform: true,
        parentId: true,
        parent: { select: { name: true } },
      },
    });
    const shopIds = shops.map((s) => s.id);

    const [
      productsByShop,
      credentialsByShop,
      productsByStatus,
      postsByStatus,
      taskCount,
      activeSessionCount,
      totalSessionCount,
    ] = await Promise.all([
      shopIds.length > 0
        ? this.prisma.db.product.groupBy({
            by: ['shopId'],
            where: { shopId: { in: shopIds }, deletedAt: null },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      shopIds.length > 0
        ? this.prisma.db.shopCredential.groupBy({
            by: ['shopId'],
            where: { shopId: { in: shopIds }, deletedAt: null },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      this.prisma.db.product.groupBy({
        by: ['status'],
        where: { ownerId: userId, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.db.post.groupBy({
        by: ['status'],
        where: { authorId: userId, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.db.generationTask.count({ where: { userId } }),
      this.prisma.db.session.count({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() }, epoch: user.sessionEpoch },
      }),
      this.prisma.db.session.count({ where: { userId } }),
    ]);

    const productCountByShop = new Map(productsByShop.map((r) => [r.shopId, r._count._all]));
    const credentialCountByShop = new Map(credentialsByShop.map((r) => [r.shopId, r._count._all]));

    const bytesUsed = user.storageUsage?.bytesUsed ?? 0n;
    const quotaBytes = user.storageUsage?.quotaBytes ?? 0n;
    const productTotal = productsByStatus.reduce((sum, r) => sum + r._count._all, 0);
    const postTotal = postsByStatus
      .filter((r) => r.status !== 'DELETED')
      .reduce((sum, r) => sum + r._count._all, 0);

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      roles: user.roles.map((r) => r.role.slug),
      bio: user.bio,
      shopCount: shops.length,
      productCount: productTotal,
      postCount: postTotal,
      taskCount,
      storageBytes: bytesUsed.toString(),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
      passwordChangedAt: user.passwordChangedAt?.toISOString() ?? null,
      sessionEpoch: user.sessionEpoch,
      activeSessionCount,
      totalSessionCount,
      storageQuotaBytes: quotaBytes.toString(),
      storageRecycledBytes: (user.storageUsage?.recycledBytes ?? 0n).toString(),
      storageUsedPercent:
        quotaBytes > 0n
          ? Math.round((Number(bytesUsed) / Number(quotaBytes)) * 1000) / 10
          : 0,
      shops: shops.map((shop) => ({
        id: shop.id,
        name: shop.name,
        type: shop.type,
        status: shop.status,
        platform: shop.platform,
        parentId: shop.parentId,
        parentName: shop.parent?.name ?? null,
        productCount: productCountByShop.get(shop.id) ?? 0,
        credentialCount: credentialCountByShop.get(shop.id) ?? 0,
      })),
      shopStats: {
        main: shops.filter((s) => s.type === 'MAIN').length,
        sub: shops.filter((s) => s.type === 'SUB').length,
      },
      productStats: {
        total: productTotal,
        byStatus: productsByStatus.map((r) => ({ status: r.status, count: r._count._all })),
      },
      postStats: {
        total: postTotal,
        byStatus: postsByStatus.map((r) => ({ status: r.status, count: r._count._all })),
      },
      // 固定为 false:管理站没有任何读取用户店铺密码的入口
      canViewShopPasswords: false,
    };
  }

  // ---------------------------------------------------------------------------
  // 逐级下钻:用户 -> 店铺 -> 商品
  // ---------------------------------------------------------------------------

  /**
   * 某用户的店铺列表(含凭据条目)。
   * 凭据用 CREDENTIAL_SAFE_SELECT 投影,**password 相关字段一律不查询、不返回**。
   */
  async listShops(
    userId: string,
    query: CursorQuery,
  ): Promise<{ items: AdminShopDetailView[]; nextCursor: string | null; hasMore: boolean }> {
    await this.assertUserExists(userId);

    const rows = await this.prisma.db.shop.findMany({
      where: { ownerId: userId, deletedAt: null, ...this.cursorWhere(query.cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        platform: true,
        parentId: true,
        url: true,
        contactName: true,
        contactInfo: true,
        createdAt: true,
        updatedAt: true,
        parent: { select: { name: true } },
        credentials: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: CREDENTIAL_SAFE_SELECT,
        },
      },
    });

    const page = rows.slice(0, query.limit);
    const shopIds = page.map((s) => s.id);
    const [productCounts, childCounts] = await Promise.all([
      shopIds.length > 0
        ? this.prisma.db.product.groupBy({
            by: ['shopId'],
            where: { shopId: { in: shopIds }, deletedAt: null },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      shopIds.length > 0
        ? this.prisma.db.shop.groupBy({
            by: ['parentId'],
            where: { parentId: { in: shopIds }, deletedAt: null },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const productCountByShop = new Map(productCounts.map((r) => [r.shopId, r._count._all]));
    const childCountByShop = new Map(
      childCounts.map((r) => [r.parentId ?? '', r._count._all] as const),
    );

    return {
      items: page.map((shop) => ({
        id: shop.id,
        name: shop.name,
        type: shop.type,
        status: shop.status,
        platform: shop.platform,
        parentId: shop.parentId,
        parentName: shop.parent?.name ?? null,
        url: shop.url,
        contactName: shop.contactName,
        contactInfo: shop.contactInfo,
        productCount: productCountByShop.get(shop.id) ?? 0,
        childCount: childCountByShop.get(shop.id) ?? 0,
        createdAt: shop.createdAt.toISOString(),
        updatedAt: shop.updatedAt.toISOString(),
        // 只有用途/账号/登录地址/备注;password 字段在类型与查询两层都不存在
        credentials: shop.credentials.map(
          (c): AdminShopCredentialView => ({
            id: c.id,
            purpose: c.purpose,
            account: c.account,
            loginUrl: c.loginUrl,
            note: c.note,
          }),
        ),
      })),
      nextCursor: rows.length > query.limit ? this.encodeRowCursor(page.at(-1)) : null,
      hasMore: rows.length > query.limit,
    };
  }

  /** 某用户某店铺下的商品列表。归属条件写在查询里,不做"先查再比对"。 */
  async listShopProducts(
    userId: string,
    shopId: string,
    query: CursorQuery,
  ): Promise<{ items: AdminProductSummaryView[]; nextCursor: string | null; hasMore: boolean }> {
    const shop = await this.prisma.db.shop.findFirst({
      where: { id: shopId, ownerId: userId, deletedAt: null },
      select: { id: true },
    });
    if (!shop) throw AppException.notFound('店铺不存在或不属于该用户');

    const rows = await this.prisma.db.product.findMany({
      where: { shopId, ownerId: userId, deletedAt: null, ...this.cursorWhere(query.cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        name: true,
        sku: true,
        status: true,
        price: true,
        currency: true,
        stock: true,
        imageAssetIds: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const page = rows.slice(0, query.limit);
    return {
      items: page.map((product) => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
        status: product.status,
        // Decimal 转字符串,禁止转 number
        price: product.price?.toString() ?? null,
        currency: product.currency,
        stock: product.stock,
        imageCount: product.imageAssetIds.length,
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? this.encodeRowCursor(page.at(-1)) : null,
      hasMore: rows.length > query.limit,
    };
  }

  // ---------------------------------------------------------------------------
  // 启用 / 禁用
  // ---------------------------------------------------------------------------

  /**
   * 启用或禁用用户。
   *
   * 禁用时通过 `SessionService.revokeAllForUser` **递增 sessionEpoch 并撤销全部会话**,
   * 旧会话在下一次请求即失效,不等自然过期。
   *
   * 保护路径 ①:禁用最后一个处于 ACTIVE 且拥有 super_admin 的账号时抛 LAST_SUPER_ADMIN。
   */
  async setStatus(
    actor: AuthUser,
    userId: string,
    input: AdminUserStatusInput,
    meta: ClientMeta,
  ): Promise<{ id: string; status: 'ACTIVE' | 'DISABLED' }> {
    if (actor.id === userId && input.status === 'DISABLED') {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, '不能禁用自己的账号');
    }

    const before = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, status: true, email: true },
    });
    if (!before) throw AppException.notFound('用户不存在或已删除');

    const nextStatus = input.status as UserStatus;

    await this.prisma.db.$transaction(async (tx) => {
      if (nextStatus === UserStatus.DISABLED) {
        await this.assertSuperAdminRemains(tx, userId);
      }
      await tx.user.update({ where: { id: userId }, data: { status: nextStatus } });
    });

    if (nextStatus === UserStatus.DISABLED) {
      // epoch 前移 + 会话撤销 + SSE 通知在线页面立刻跳登录
      await this.sessions.revokeAllForUser(userId, 'disabled');
    }

    await this.audit.record({
      actor,
      action: input.status === 'DISABLED' ? 'admin.user.disable' : 'admin.user.enable',
      targetType: 'User',
      targetId: userId,
      diff: this.audit.buildDiff({ status: before.status }, { status: input.status }),
      metadata: { reason: input.reason ?? null, targetEmail: before.email },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { id: userId, status: input.status };
  }

  // ---------------------------------------------------------------------------
  // 创建管理员(超级管理员专属)
  // ---------------------------------------------------------------------------

  /**
   * 新建管理员账号。
   *
   * - 密码用 Argon2id 哈希,明文不落库、不进审计 metadata、不写日志。
   * - 邮箱已存在(含软删除占用唯一键)时返回 CONFLICT,不静默改密或提权;
   *   已有普通用户请用 `PUT /admin/users/:id/roles` 授予角色。
   * - 不能授予高于操作者自身的角色(双重保险,控制器已限超管)。
   */
  async createAdmin(
    actor: AuthUser,
    input: AdminCreateAdminInput,
    meta: ClientMeta,
  ): Promise<AdminUserSummary> {
    const roleLevel = ROLE_LEVEL[input.role] ?? 0;
    if (roleLevel > actor.roleLevel) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, '不能授予高于自己等级的角色');
    }

    const existing = await this.prisma.db.user.findUnique({
      where: { email: input.email },
      select: { id: true, deletedAt: true },
    });
    if (existing) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        existing.deletedAt
          ? '该邮箱曾被使用且仍占用唯一键,请换用其他邮箱'
          : '该邮箱已注册。若需提权,请在用户详情中授予管理员角色',
      );
    }

    const passwordHash = await this.crypto.hashPassword(input.password);

    const created = await this.prisma.db.$transaction(async (tx) => {
      const role = await tx.role.findUniqueOrThrow({ where: { slug: input.role } });
      return tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          roles: { create: { roleId: role.id, grantedBy: actor.id } },
          storageUsage: {
            create: { quotaBytes: BigInt(DEFAULT_STORAGE_QUOTA_BYTES) },
          },
        },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          lastActiveAt: true,
          roles: { select: { role: { select: { slug: true } } } },
        },
      });
    });

    await this.audit.record({
      actor,
      action: 'admin.user.create_admin',
      targetType: 'User',
      targetId: created.id,
      // 故意不写 password / passwordHash
      metadata: { email: created.email, role: input.role },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    this.logger.log(`管理员账号已创建:${created.id} role=${input.role} by=${actor.id}`);

    return {
      id: created.id,
      email: created.email,
      displayName: created.displayName,
      status: created.status,
      roles: created.roles.map((r) => r.role.slug),
      shopCount: 0,
      productCount: 0,
      postCount: 0,
      taskCount: 0,
      storageBytes: '0',
      createdAt: created.createdAt.toISOString(),
      lastLoginAt: created.lastLoginAt?.toISOString() ?? null,
      lastActiveAt: created.lastActiveAt?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // 角色管理(超级管理员专属)
  // ---------------------------------------------------------------------------

  /**
   * 覆盖式设置用户角色(授予/撤销 admin、super_admin 都走这里)。
   *
   * 两条防线:
   *  - 防提权:不允许把任何账号(尤其是自己)设置到高于操作者自身的等级。
   *  - 保护路径 ②:撤销最后一个 super_admin 时抛 LAST_SUPER_ADMIN。
   *
   * 角色变化后同样撤销该用户的全部会话,避免旧会话继续按老权限操作。
   */
  async setRoles(
    actor: AuthUser,
    userId: string,
    input: AdminUserRoleInput,
    meta: ClientMeta,
  ): Promise<{ id: string; roles: string[] }> {
    const nextSlugs = [...new Set(input.roles)] as RoleSlug[];
    const nextLevel = nextSlugs.reduce((max, slug) => Math.max(max, ROLE_LEVEL[slug] ?? 0), 0);

    if (nextLevel > actor.roleLevel) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        actor.id === userId
          ? '不能把自己的角色提升到更高等级'
          : '不能授予高于自己等级的角色',
      );
    }

    const before = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        roles: { select: { role: { select: { slug: true } } } },
      },
    });
    if (!before) throw AppException.notFound('用户不存在或已删除');
    const beforeSlugs = before.roles.map((r) => r.role.slug);

    const roles = await this.prisma.db.role.findMany({
      where: { slug: { in: nextSlugs } },
      select: { id: true, slug: true },
    });
    if (roles.length !== nextSlugs.length) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '存在未定义的角色标识');
    }

    const losesSuperAdmin =
      beforeSlugs.includes(ROLE_SUPER_ADMIN) && !nextSlugs.includes(ROLE_SUPER_ADMIN);

    await this.prisma.db.$transaction(async (tx) => {
      if (losesSuperAdmin) {
        await this.assertSuperAdminRemains(tx, userId);
      }
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({
        data: roles.map((role) => ({ userId, roleId: role.id, grantedBy: actor.id })),
      });
    });

    // 权限变更后旧会话必须重新登录,避免按旧角色继续操作
    await this.sessions.revokeAllForUser(userId, 'revoked');

    await this.audit.record({
      actor,
      action: 'admin.user.roles.update',
      targetType: 'User',
      targetId: userId,
      diff: this.audit.buildDiff({ roles: beforeSlugs.sort() }, { roles: [...nextSlugs].sort() }),
      metadata: {
        targetEmail: before.email,
        granted: nextSlugs.filter((s) => !beforeSlugs.includes(s)),
        revoked: beforeSlugs.filter((s) => !nextSlugs.includes(s as RoleSlug)),
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { id: userId, roles: nextSlugs };
  }

  // ---------------------------------------------------------------------------
  // 删除(软删除)
  // ---------------------------------------------------------------------------

  /**
   * 删除用户。采用软删除保留历史数据(帖子、任务、审计追溯)。
   * 保护路径 ③:删除最后一个 super_admin 时抛 LAST_SUPER_ADMIN。
   */
  async remove(
    actor: AuthUser,
    userId: string,
    reason: string | undefined,
    meta: ClientMeta,
  ): Promise<{ id: string; deleted: true }> {
    if (actor.id === userId) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, '不能删除自己的账号');
    }

    const before = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, status: true },
    });
    if (!before) throw AppException.notFound('用户不存在或已删除');

    await this.prisma.db.$transaction(async (tx) => {
      await this.assertSuperAdminRemains(tx, userId);
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: new Date(), status: UserStatus.DISABLED },
      });
    });

    await this.sessions.revokeAllForUser(userId, 'disabled');

    await this.audit.record({
      actor,
      action: 'admin.user.delete',
      targetType: 'User',
      targetId: userId,
      diff: this.audit.buildDiff<{ deletedAt: string | null; status: string }>(
        { deletedAt: null, status: before.status },
        { deletedAt: new Date().toISOString(), status: UserStatus.DISABLED },
      ),
      metadata: { reason: reason ?? null, targetEmail: before.email },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    this.logger.log(`管理员 ${actor.email} 删除了用户 ${before.email}`);
    return { id: userId, deleted: true };
  }

  // ---------------------------------------------------------------------------
  // 最后一个超级管理员保护
  // ---------------------------------------------------------------------------

  /**
   * 断言"操作完成后系统里仍至少有一个可用的超级管理员"。
   *
   * 撤销 super_admin 角色、禁用用户、删除用户**三条路径都调用本方法**,
   * 且必须在事务内调用:`count` 与随后的写操作处于同一事务,
   * 避免两个并发请求各自看到"还有另一个超管"而把最后两个同时干掉。
   *
   * 判定口径:处于 ACTIVE、未软删除、且拥有 super_admin 角色的用户数。
   * 目标本身不是"可用的超级管理员"时直接返回——这类操作不会减少超管数量。
   */
  private async assertSuperAdminRemains(
    tx: AdminTransactionClient,
    targetUserId: string,
  ): Promise<void> {
    const target = await tx.user.findUnique({
      where: { id: targetUserId },
      select: {
        status: true,
        deletedAt: true,
        roles: { select: { role: { select: { slug: true } } } },
      },
    });
    if (!target) throw AppException.notFound('用户不存在或已删除');

    const isActiveSuperAdmin =
      target.deletedAt === null &&
      target.status === UserStatus.ACTIVE &&
      target.roles.some((r) => r.role.slug === ROLE_SUPER_ADMIN);
    if (!isActiveSuperAdmin) return;

    const remaining = await tx.user.count({
      where: {
        id: { not: targetUserId },
        deletedAt: null,
        status: UserStatus.ACTIVE,
        roles: { some: { role: { slug: ROLE_SUPER_ADMIN } } },
      },
    });

    if (remaining === 0) {
      throw AppException.conflict(
        ERROR_CODES.LAST_SUPER_ADMIN,
        '系统必须保留至少一个可用的超级管理员,请先指定另一个超级管理员',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  private async assertUserExists(userId: string): Promise<void> {
    const exists = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!exists) throw AppException.notFound('用户不存在或已删除');
  }

  /** 游标解析:(createdAt, id) 复合游标,保证同一毫秒内的多条记录不重不漏 */
  private cursorWhere(cursor?: string): { OR?: Array<Record<string, unknown>> } {
    if (!cursor) return {};
    const decoded = decodeCursor<ListCursor>(cursor);
    if (!decoded?.createdAt || !decoded.id) return {};
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) return {};
    return {
      OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: decoded.id } }],
    };
  }

  private encodeRowCursor(row: { id: string; createdAt: Date } | undefined): string | null {
    if (!row) return null;
    return encodeCursor({ createdAt: row.createdAt.toISOString(), id: row.id });
  }

  /** 供控制器回显:当前操作者能授予的最高角色 */
  static grantableRoles(actor: AuthUser): RoleSlug[] {
    const all: RoleSlug[] = ['user', ROLE_ADMIN, ROLE_SUPER_ADMIN];
    return all.filter((slug) => ROLE_LEVEL[slug] <= actor.roleLevel);
  }
}