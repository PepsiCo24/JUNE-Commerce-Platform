import { Injectable } from '@nestjs/common';
import { ProductStatus, ShopType, type JunePrismaClient, type Prisma, type Shop } from '@june/db';
import {
  ERROR_CODES,
  INHERITABLE_SHOP_FIELD_VALUES,
  SHOP_MAX_DEPTH,
  type InheritableShopField,
  type PageResult,
  type ShopCreateInput,
  type ShopDeleteInput,
  type ShopDetail,
  type ShopGraph,
  type ShopStats,
  type ShopSummary,
  type ShopUpdateInput,
  type shopListQuerySchema,
  type shopResetInheritanceSchema,
} from '@june/shared';
import type { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { ClientMeta, ShopDeleteResult } from './commerce.types';
import { isUniqueViolation } from './prisma-errors';
import {
  buildPropagationPlan,
  buildPropagationUpdates,
  collectExplicitInheritableFields,
  computeShopInheritance,
  computeSubtreeHeight,
  detectShopCycle,
  exceedsMaxDepth,
  mergeOverriddenFields,
  pickInheritableValues,
  removeOverriddenFields,
  resolveCreateInheritance,
  type ChildrenResolver,
  type InheritableValues,
  type ParentResolver,
} from './shop-inheritance';

export type ShopListQuery = z.infer<typeof shopListQuerySchema>;
export type ShopResetInheritanceInput = z.infer<typeof shopResetInheritanceSchema>;

/** 店铺关系图数据上限。单个用户的店铺数量远小于此值,超出时说明数据异常。 */
const SHOP_GRAPH_MAX_NODES = 500;

/**
 * 事务回调里拿到的客户端类型。
 * 扩展后的客户端(PrismaService.db)在 $transaction 中给出的不是基础 PrismaClient,
 * 因此这里从扩展客户端自身推导,而不是用 @june/db 的 JuneTransactionClient。
 */
type CommerceTransactionClient = Parameters<Parameters<JunePrismaClient['$transaction']>[0]>[0];

interface ShopRow {
  id: string;
  name: string;
  type: ShopType;
  status: Shop['status'];
  platform: string | null;
  url: string | null;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  parent: { name: string } | null;
}

interface ShopCounts {
  productCount: number;
  childCount: number;
  credentialCount: number;
}

/** 店铺关系解析器。一次查出当前用户的全部店铺关系,后续判定都在内存里做,避免逐跳查询。 */
interface ShopRelationGraph {
  getParent: ParentResolver;
  getChildren: ChildrenResolver;
}

@Injectable()
export class ShopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  async list(user: AuthUser, query: ShopListQuery): Promise<PageResult<ShopSummary>> {
    const where: Prisma.ShopWhereInput = {
      ownerId: user.id,
      deletedAt: null,
      ...(query.type === 'ALL' ? {} : { type: query.type }),
      ...(query.status === 'ALL' ? {} : { status: query.status }),
      ...(query.parentId ? { parentId: query.parentId } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { platform: { contains: query.q, mode: 'insensitive' } },
              { contactName: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.db.shop.findMany({
        where,
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          platform: true,
          url: true,
          parentId: true,
          createdAt: true,
          updatedAt: true,
          parent: { select: { name: true } },
        },
        orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.db.shop.count({ where }),
    ]);

    // 关联计数批量取,不在循环里查库
    const counts = await this.countsFor(rows.map((row) => row.id));

    return {
      items: rows.map((row) => this.toSummary(row, counts.get(row.id))),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async stats(user: AuthUser): Promise<ShopStats> {
    const [byType, shops, productGroups] = await Promise.all([
      this.prisma.db.shop.groupBy({
        by: ['type'],
        where: { ownerId: user.id, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.db.shop.findMany({
        where: { ownerId: user.id, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.db.product.groupBy({
        by: ['shopId'],
        where: { ownerId: user.id, deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    const mainCount = byType.find((entry) => entry.type === ShopType.MAIN)?._count._all ?? 0;
    const subCount = byType.find((entry) => entry.type === ShopType.SUB)?._count._all ?? 0;
    const productCounts = new Map(productGroups.map((entry) => [entry.shopId, entry._count._all]));

    return {
      total: mainCount + subCount,
      mainCount,
      subCount,
      // 未售出/无商品的店铺同样列出(计数为 0),避免界面上"店铺凭空消失"
      productCountByShop: shops
        .map((shop) => ({
          shopId: shop.id,
          shopName: shop.name,
          productCount: productCounts.get(shop.id) ?? 0,
        }))
        .sort((a, b) => b.productCount - a.productCount || a.shopName.localeCompare(b.shopName)),
    };
  }

  async graph(user: AuthUser): Promise<ShopGraph> {
    const shops = await this.prisma.db.shop.findMany({
      where: { ownerId: user.id, deletedAt: null },
      select: { id: true, name: true, type: true, status: true, platform: true, parentId: true },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
      take: SHOP_GRAPH_MAX_NODES,
    });

    const counts = await this.countsFor(shops.map((shop) => shop.id));
    const nodeIds = new Set(shops.map((shop) => shop.id));

    return {
      nodes: shops.map((shop) => ({
        id: shop.id,
        name: shop.name,
        type: shop.type,
        status: shop.status,
        productCount: counts.get(shop.id)?.productCount ?? 0,
        platform: shop.platform,
      })),
      // 只连接当前结果集内的店铺,不会因为父店被过滤掉而产生悬空边
      edges: shops.flatMap((shop) =>
        shop.parentId !== null && nodeIds.has(shop.parentId)
          ? [{ id: `${shop.parentId}->${shop.id}`, source: shop.parentId, target: shop.id }]
          : [],
      ),
    };
  }

  async detail(user: AuthUser, id: string): Promise<ShopDetail> {
    const shop = await this.mustOwn(user, id);
    return this.buildDetail(shop);
  }

  // ---------------------------------------------------------------------------
  // 创建 / 更新
  // ---------------------------------------------------------------------------

  async create(user: AuthUser, input: ShopCreateInput, meta: ClientMeta): Promise<ShopDetail> {
    let parent: (Shop | null) = null;
    if (input.parentId) {
      parent = await this.loadAttachableParent(user, input.parentId);
      const graph = await this.loadRelationGraph(user.id);
      // 新店还没有下级,子树高度为 1
      if (exceedsMaxDepth({ newParentId: parent.id, subtreeHeight: 1, getParent: graph.getParent })) {
        throw AppException.badRequest(
          ERROR_CODES.SHOP_DEPTH_EXCEEDED,
          `店铺层级最多 ${SHOP_MAX_DEPTH} 级`,
        );
      }
    }

    const inheritance = resolveCreateInheritance(input, parent);

    const created = await this.prisma.db.shop.create({
      data: {
        ownerId: user.id,
        type: parent ? ShopType.SUB : ShopType.MAIN,
        status: input.status,
        name: input.name,
        url: input.url ?? null,
        description: input.description ?? null,
        parentId: parent?.id ?? null,
        // 生效值写实到子店行上:列表查询无需回溯主店,升为主店时也不会字段变空
        platform: inheritance.values.platform ?? null,
        contactName: inheritance.values.contactName ?? null,
        contactInfo: inheritance.values.contactInfo ?? null,
        note: inheritance.values.note ?? null,
        overriddenFields: inheritance.overriddenFields,
      },
    });

    await this.audit.record({
      actor: user,
      action: 'shop.create',
      targetType: 'Shop',
      targetId: created.id,
      metadata: {
        name: created.name,
        type: created.type,
        parentId: created.parentId,
        overriddenFields: created.overriddenFields,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.buildDetail(created);
  }

  async update(
    user: AuthUser,
    id: string,
    input: ShopUpdateInput,
    meta: ClientMeta,
  ): Promise<ShopDetail> {
    const before = await this.mustOwn(user, id);

    const explicitFields = collectExplicitInheritableFields(input);
    const parentChanged = input.parentId !== undefined && (input.parentId ?? null) !== before.parentId;

    let nextParent: Shop | null = null;
    let nextType: ShopType = before.type;
    let nextParentId: string | null = before.parentId;

    if (parentChanged) {
      if (input.parentId) {
        nextParent = await this.loadAttachableParent(user, input.parentId);
        const graph = await this.loadRelationGraph(user.id);
        this.assertNoCycle(id, nextParent.id, graph);
        const subtreeHeight = computeSubtreeHeight(id, graph.getChildren);
        if (exceedsMaxDepth({ newParentId: nextParent.id, subtreeHeight, getParent: graph.getParent })) {
          throw AppException.badRequest(
            ERROR_CODES.SHOP_DEPTH_EXCEEDED,
            `店铺层级最多 ${SHOP_MAX_DEPTH} 级,该店铺下还有 ${subtreeHeight - 1} 层子店铺`,
          );
        }
        nextType = ShopType.SUB;
        nextParentId = nextParent.id;
      } else {
        nextType = ShopType.MAIN;
        nextParentId = null;
      }
    }

    const inheritableData: Partial<InheritableValues> = {};
    for (const field of INHERITABLE_SHOP_FIELD_VALUES) {
      const value = input[field];
      if (value !== undefined) inheritableData[field] = value ?? null;
    }

    let overriddenFields: InheritableShopField[] = [];
    if (nextType === ShopType.SUB) {
      // 显式传入可继承字段 = 覆盖
      overriddenFields = mergeOverriddenFields(before.overriddenFields, explicitFields);
      if (nextParent) {
        // 换挂到新主店:未覆盖的字段改为跟随新主店
        const parentValues = pickInheritableValues(nextParent);
        for (const field of INHERITABLE_SHOP_FIELD_VALUES) {
          if (!overriddenFields.includes(field)) inheritableData[field] = parentValues[field];
        }
      }
    }
    // 升为主店时清空覆盖标记,但保留当前生效值

    const data: Prisma.ShopUncheckedUpdateInput = {
      ...inheritableData,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.url !== undefined ? { url: input.url ?? null } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(parentChanged ? { parentId: nextParentId, type: nextType } : {}),
      overriddenFields,
    };

    const propagationPlan = buildPropagationPlan(input);

    const after = await this.prisma.db.$transaction(async (tx) => {
      const updated = await tx.shop.update({ where: { id }, data });

      // 主店同步:一个字段一条 updateMany,已覆盖该字段的子店被 where 排除在外
      if (updated.type === ShopType.MAIN && input.propagateToChildren && propagationPlan.length > 0) {
        for (const op of buildPropagationUpdates(updated.id, propagationPlan)) {
          await tx.shop.updateMany(op);
        }
      }

      return updated;
    });

    await this.audit.record({
      actor: user,
      action: 'shop.update',
      targetType: 'Shop',
      targetId: id,
      diff: this.audit.buildDiff({ ...before }, { ...after }),
      metadata: {
        propagated:
          after.type === ShopType.MAIN && input.propagateToChildren
            ? propagationPlan.map((step) => step.field)
            : [],
        overriddenFields: after.overriddenFields,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.buildDetail(after);
  }

  /** 清除指定字段的覆盖标记,并重新取回主店当前的值 */
  async resetInheritance(
    user: AuthUser,
    id: string,
    input: ShopResetInheritanceInput,
    meta: ClientMeta,
  ): Promise<ShopDetail> {
    const shop = await this.mustOwn(user, id);
    if (!shop.parentId) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        '只有子店铺才有可继承字段,主店铺没有继承来源',
      );
    }

    const parent = await this.prisma.db.shop.findFirst({
      where: { id: shop.parentId, ownerId: user.id, deletedAt: null },
    });
    if (!parent) throw AppException.notOwner();

    const parentValues = pickInheritableValues(parent);
    const restored: Partial<InheritableValues> = {};
    for (const field of input.fields) restored[field] = parentValues[field];

    const updated = await this.prisma.db.shop.update({
      where: { id },
      data: {
        ...restored,
        overriddenFields: removeOverriddenFields(shop.overriddenFields, input.fields),
      },
    });

    await this.audit.record({
      actor: user,
      action: 'shop.reset-inheritance',
      targetType: 'Shop',
      targetId: id,
      diff: this.audit.buildDiff({ ...shop }, { ...updated }),
      metadata: { fields: input.fields, parentId: parent.id },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.buildDetail(updated);
  }

  // ---------------------------------------------------------------------------
  // 删除:显式声明子店 / 商品 / 凭据的处理方式,绝不静默级联
  // ---------------------------------------------------------------------------

  async remove(
    user: AuthUser,
    id: string,
    input: ShopDeleteInput,
    meta: ClientMeta,
  ): Promise<ShopDeleteResult> {
    const shop = await this.mustOwn(user, id);

    if (input.confirmName !== shop.name) {
      throw AppException.validation(
        [{ path: 'confirmName', message: '店铺名称不一致,请完整输入店铺名称以确认删除' }],
        '二次确认失败:请完整输入店铺名称',
      );
    }

    const [children, productCount, credentialCount] = await Promise.all([
      this.prisma.db.shop.findMany({
        where: { parentId: id, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.db.product.count({ where: { shopId: id, deletedAt: null } }),
      this.prisma.db.shopCredential.count({ where: { shopId: id, deletedAt: null } }),
    ]);

    const childIds = children.map((row) => row.id);

    // 迁移目标先在事务外校验归属,避免事务持锁期间做多余往返
    const childrenTargetId =
      input.childrenStrategy === 'move_to_shop' && childIds.length > 0
        ? await this.resolveChildrenTarget(user, id, childIds, input.childrenTargetShopId)
        : null;
    const productsTargetId =
      input.productsStrategy === 'move_to_shop' && productCount > 0
        ? await this.resolveProductsTarget(user, id, input.productsTargetShopId)
        : null;

    const now = new Date();

    const affected = await this.prisma.db.$transaction(async (tx) => {
      let childrenAffected = 0;
      let productsAffected = 0;
      let credentialsAffected = 0;

      if (childIds.length > 0) {
        switch (input.childrenStrategy) {
          case 'reject':
            throw AppException.conflict(
              ERROR_CODES.SHOP_HAS_DEPENDENTS,
              `该店铺下仍有 ${childIds.length} 个子店铺,请先选择子店铺的处理方式`,
            );
          case 'promote_to_main': {
            // 生效值本来就写实在子店行上,升主后字段不会变空;清空覆盖标记因为已无继承来源
            const res = await tx.shop.updateMany({
              where: { parentId: id, deletedAt: null },
              data: { parentId: null, type: ShopType.MAIN, overriddenFields: [] },
            });
            childrenAffected = res.count;
            break;
          }
          case 'move_to_shop': {
            const res = await tx.shop.updateMany({
              where: { parentId: id, deletedAt: null },
              data: { parentId: childrenTargetId },
            });
            childrenAffected = res.count;
            break;
          }
          case 'delete': {
            // 子店自己还挂着商品或凭据时不允许顺带删除,必须先显式处理,避免隐式级联
            const [childProducts, childCredentials] = await Promise.all([
              tx.product.count({ where: { shopId: { in: childIds }, deletedAt: null } }),
              tx.shopCredential.count({ where: { shopId: { in: childIds }, deletedAt: null } }),
            ]);
            if (childProducts + childCredentials > 0) {
              throw AppException.conflict(
                ERROR_CODES.SHOP_HAS_DEPENDENTS,
                `子店铺下仍有 ${childProducts} 个商品与 ${childCredentials} 条账号凭据,请先单独处理这些子店铺`,
              );
            }
            const res = await tx.shop.updateMany({
              where: { parentId: id, deletedAt: null },
              data: { deletedAt: now },
            });
            childrenAffected = res.count;
            break;
          }
        }
      }

      if (productCount > 0) {
        switch (input.productsStrategy) {
          case 'reject':
            throw AppException.conflict(
              ERROR_CODES.SHOP_HAS_DEPENDENTS,
              `该店铺下仍有 ${productCount} 个商品,请先选择商品的处理方式`,
            );
          case 'move_to_shop': {
            try {
              const res = await tx.product.updateMany({
                where: { shopId: id, deletedAt: null },
                data: { shopId: productsTargetId as string },
              });
              productsAffected = res.count;
            } catch (err) {
              if (isUniqueViolation(err)) {
                throw AppException.conflict(
                  ERROR_CODES.PRODUCT_SKU_DUPLICATE,
                  '目标店铺已存在相同 SKU 的商品,请先处理重复 SKU 再迁移',
                );
              }
              throw err;
            }
            break;
          }
          case 'archive': {
            const res = await tx.product.updateMany({
              where: { shopId: id, deletedAt: null },
              data: { status: ProductStatus.ARCHIVED },
            });
            productsAffected = res.count;
            break;
          }
          case 'delete': {
            productsAffected = await this.softDeleteShopProducts(tx, id, now);
            break;
          }
        }
      }

      if (credentialCount > 0) {
        if (input.credentialsStrategy === 'reject') {
          throw AppException.conflict(
            ERROR_CODES.SHOP_HAS_DEPENDENTS,
            `该店铺下仍有 ${credentialCount} 条账号凭据,请先删除或另行处理(凭据与账号强绑定,不支持迁移)`,
          );
        }
        const res = await tx.shopCredential.updateMany({
          where: { shopId: id, deletedAt: null },
          data: { deletedAt: now },
        });
        credentialsAffected = res.count;
      }

      await tx.shop.update({ where: { id }, data: { deletedAt: now } });

      return { childrenAffected, productsAffected, credentialsAffected };
    });

    await this.audit.record({
      actor: user,
      action: 'shop.delete',
      targetType: 'Shop',
      targetId: id,
      metadata: {
        name: shop.name,
        type: shop.type,
        childrenStrategy: input.childrenStrategy,
        childrenAffected: affected.childrenAffected,
        childrenTargetShopId: childrenTargetId,
        productsStrategy: input.productsStrategy,
        productsAffected: affected.productsAffected,
        productsTargetShopId: productsTargetId,
        // 注意:AuditService 会把任何含 "credential" 的键脱敏成 [redacted],
        // 这里用 accounts* 命名,保证策略与影响数量能真正落进审计日志
        accountsStrategy: input.credentialsStrategy,
        accountsAffected: affected.credentialsAffected,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      id,
      childrenStrategy: input.childrenStrategy,
      childrenAffected: affected.childrenAffected,
      productsStrategy: input.productsStrategy,
      productsAffected: affected.productsAffected,
      credentialsStrategy: input.credentialsStrategy,
      credentialsAffected: affected.credentialsAffected,
    };
  }

  // ---------------------------------------------------------------------------
  // 供其他服务复用的归属校验
  // ---------------------------------------------------------------------------

  /** 校验店铺属于当前用户(带 deletedAt 条件)。查询本身即带归属条件,不做"先查再比对"。 */
  async mustOwn(user: AuthUser, id: string): Promise<Shop> {
    const shop = await this.prisma.db.shop.findFirst({
      where: { id, ownerId: user.id, deletedAt: null },
    });
    if (!shop) throw AppException.notOwner();
    return shop;
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  /**
   * 校验待挂接的父店。
   *
   * 这里是本模块唯一"先查后比对归属"的地方:接口契约要求区分
   * SHOP_CROSS_OWNER 与 SHOP_PARENT_MUST_BE_MAIN,必须读到 ownerId/type 才能给出对应错误码。
   * 响应体只有错误码与通用文案,不泄漏对方店铺的任何信息。
   */
  private async loadAttachableParent(user: AuthUser, parentId: string): Promise<Shop> {
    const parent = await this.prisma.db.shop.findFirst({ where: { id: parentId, deletedAt: null } });
    if (!parent) throw AppException.notOwner();

    if (parent.ownerId !== user.id) {
      throw AppException.badRequest(ERROR_CODES.SHOP_CROSS_OWNER);
    }
    if (parent.type !== ShopType.MAIN) {
      throw AppException.badRequest(ERROR_CODES.SHOP_PARENT_MUST_BE_MAIN);
    }
    return parent;
  }

  /**
   * 循环检测:沿新父店的 parent 链向上遍历,命中自己即拒绝。
   * 带最大跳数保护,脏数据成环也不会死循环。
   */
  private assertNoCycle(shopId: string, newParentId: string, graph: ShopRelationGraph): void {
    if (detectShopCycle({ shopId, newParentId, getParent: graph.getParent })) {
      throw AppException.badRequest(ERROR_CODES.SHOP_CYCLE_DETECTED);
    }
  }

  /** 一次查出当前用户的店铺关系,层级与循环判定都在内存完成 */
  private async loadRelationGraph(ownerId: string): Promise<ShopRelationGraph> {
    const rows = await this.prisma.db.shop.findMany({
      where: { ownerId, deletedAt: null },
      select: { id: true, parentId: true },
    });

    const parentOf = new Map<string, string | null>();
    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
      parentOf.set(row.id, row.parentId);
      if (row.parentId) {
        const siblings = childrenOf.get(row.parentId) ?? [];
        siblings.push(row.id);
        childrenOf.set(row.parentId, siblings);
      }
    }

    return {
      getParent: (shopId) => parentOf.get(shopId) ?? null,
      getChildren: (shopId) => childrenOf.get(shopId) ?? [],
    };
  }

  private async resolveChildrenTarget(
    user: AuthUser,
    shopId: string,
    childIds: string[],
    targetShopId: string | undefined,
  ): Promise<string> {
    if (!targetShopId) {
      throw AppException.validation([
        { path: 'childrenTargetShopId', message: '请选择子店铺迁移到的目标主店铺' },
      ]);
    }
    if (targetShopId === shopId) {
      throw AppException.validation([
        { path: 'childrenTargetShopId', message: '不能迁移到正在删除的店铺' },
      ]);
    }

    const target = await this.mustOwn(user, targetShopId);
    if (target.type !== ShopType.MAIN) {
      throw AppException.badRequest(ERROR_CODES.SHOP_PARENT_MUST_BE_MAIN);
    }

    const graph = await this.loadRelationGraph(user.id);
    for (const childId of childIds) {
      this.assertNoCycle(childId, target.id, graph);
      const subtreeHeight = computeSubtreeHeight(childId, graph.getChildren);
      if (exceedsMaxDepth({ newParentId: target.id, subtreeHeight, getParent: graph.getParent })) {
        throw AppException.badRequest(
          ERROR_CODES.SHOP_DEPTH_EXCEEDED,
          `迁移后店铺层级会超过 ${SHOP_MAX_DEPTH} 级`,
        );
      }
    }

    return target.id;
  }

  private async resolveProductsTarget(
    user: AuthUser,
    shopId: string,
    targetShopId: string | undefined,
  ): Promise<string> {
    if (!targetShopId) {
      throw AppException.validation([
        { path: 'productsTargetShopId', message: '请选择商品迁移到的目标店铺' },
      ]);
    }
    if (targetShopId === shopId) {
      throw AppException.validation([
        { path: 'productsTargetShopId', message: '不能迁移到正在删除的店铺' },
      ]);
    }
    const target = await this.mustOwn(user, targetShopId);
    return target.id;
  }

  /**
   * 软删除店铺下的商品,并同步释放图片引用计数。
   * refCount 不回落的话,资产会永远无法进入回收流程。
   */
  private async softDeleteShopProducts(
    tx: CommerceTransactionClient,
    shopId: string,
    now: Date,
  ): Promise<number> {
    const products = await tx.product.findMany({
      where: { shopId, deletedAt: null },
      select: { imageAssetIds: true, coverAssetId: true },
    });

    const decrements = new Map<string, number>();
    for (const product of products) {
      const ids = new Set(product.imageAssetIds);
      if (product.coverAssetId) ids.add(product.coverAssetId);
      for (const assetId of ids) decrements.set(assetId, (decrements.get(assetId) ?? 0) + 1);
    }

    // 按"需要减去的次数"分组,同一次数的资产合并成一条 updateMany
    const byDelta = new Map<number, string[]>();
    for (const [assetId, delta] of decrements) {
      const bucket = byDelta.get(delta) ?? [];
      bucket.push(assetId);
      byDelta.set(delta, bucket);
    }
    for (const [delta, assetIds] of byDelta) {
      await tx.asset.updateMany({
        where: { id: { in: assetIds } },
        data: { refCount: { decrement: delta } },
      });
    }

    const res = await tx.product.updateMany({
      where: { shopId, deletedAt: null },
      data: { deletedAt: now },
    });
    return res.count;
  }

  private async countsFor(shopIds: string[]): Promise<Map<string, ShopCounts>> {
    const counts = new Map<string, ShopCounts>();
    if (shopIds.length === 0) return counts;

    for (const id of shopIds) {
      counts.set(id, { productCount: 0, childCount: 0, credentialCount: 0 });
    }

    // 三次 groupBy 批量取,与店铺数量无关(禁止 N+1)
    const [products, children, credentials] = await Promise.all([
      this.prisma.db.product.groupBy({
        by: ['shopId'],
        where: { shopId: { in: shopIds }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.db.shop.groupBy({
        by: ['parentId'],
        where: { parentId: { in: shopIds }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.db.shopCredential.groupBy({
        by: ['shopId'],
        where: { shopId: { in: shopIds }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    for (const entry of products) {
      const bucket = counts.get(entry.shopId);
      if (bucket) bucket.productCount = entry._count._all;
    }
    for (const entry of children) {
      if (!entry.parentId) continue;
      const bucket = counts.get(entry.parentId);
      if (bucket) bucket.childCount = entry._count._all;
    }
    for (const entry of credentials) {
      const bucket = counts.get(entry.shopId);
      if (bucket) bucket.credentialCount = entry._count._all;
    }

    return counts;
  }

  private toSummary(row: ShopRow, counts: ShopCounts | undefined): ShopSummary {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      platform: row.platform,
      url: row.url,
      parentId: row.parentId,
      parentName: row.parent?.name ?? null,
      productCount: counts?.productCount ?? 0,
      childCount: counts?.childCount ?? 0,
      credentialCount: counts?.credentialCount ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async buildDetail(shop: Shop): Promise<ShopDetail> {
    const [parent, counts] = await Promise.all([
      shop.parentId
        ? this.prisma.db.shop.findFirst({
            where: { id: shop.parentId, deletedAt: null },
            select: {
              name: true,
              platform: true,
              contactName: true,
              contactInfo: true,
              note: true,
            },
          })
        : Promise.resolve(null),
      this.countsFor([shop.id]),
    ]);

    const summary = this.toSummary(
      { ...shop, parent: parent ? { name: parent.name } : null },
      counts.get(shop.id),
    );

    return {
      ...summary,
      description: shop.description,
      contactName: shop.contactName,
      contactInfo: shop.contactInfo,
      note: shop.note,
      inheritance: computeShopInheritance({
        shop,
        overriddenFields: shop.overriddenFields,
        parent,
      }),
    };
  }
}