import { Injectable } from '@nestjs/common';
import { AssetKind, ProductStatus, type Asset, type Prisma, type Product } from '@june/db';
import {
  ERROR_CODES,
  decodeCursor,
  encodeCursor,
  type CursorResult,
  type ProductCreateInput,
  type ProductDetail,
  type ProductSummary,
  type ProductUpdateInput,
  type productListQuerySchema,
} from '@june/shared';
import type { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AssetUrlService } from '../assets/asset-url.service';
import { AssetsService } from '../assets/assets.service';
import type { ClientMeta, ProductOption } from './commerce.types';
import { isUniqueViolation } from './prisma-errors';
import { ShopsService } from './shops.service';

export type ProductListQuery = z.infer<typeof productListQuerySchema>;

/** 商品图片允许的资产用途:自己上传的商品图,或生图结果(复用同一 Asset,不复制文件) */
const PRODUCT_IMAGE_KINDS: AssetKind[] = [AssetKind.PRODUCT_IMAGE, AssetKind.GENERATED_IMAGE];

/** 列表/详情用的图片资产字段 */
const ASSET_URL_SELECT = {
  id: true,
  objectKey: true,
  visibility: true,
  derivatives: true,
  width: true,
  height: true,
} as const;

interface ProductRow {
  id: string;
  shopId: string;
  name: string;
  sku: string | null;
  title: string | null;
  price: Prisma.Decimal | null;
  currency: string;
  stock: number;
  status: ProductStatus;
  imageAssetIds: string[];
  updatedAt: Date;
  shop: { name: string };
  coverAsset: Pick<Asset, 'objectKey' | 'visibility' | 'derivatives'> | null;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
    private readonly urls: AssetUrlService,
    private readonly audit: AuditService,
    private readonly shops: ShopsService,
  ) {}

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  /** 商品列表。大列表用游标分页,排序字段始终带 id 作为唯一兜底,保证游标稳定。 */
  async list(user: AuthUser, query: ProductListQuery): Promise<CursorResult<ProductSummary>> {
    const where: Prisma.ProductWhereInput = {
      ownerId: user.id,
      deletedAt: null,
      ...(query.shopId ? { shopId: query.shopId } : {}),
      ...(query.status === 'ALL' ? {} : { status: query.status }),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { sku: { contains: query.q, mode: 'insensitive' } },
              { title: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const cursorId = query.cursor ? decodeCursor<{ id: string }>(query.cursor)?.id : undefined;

    const rows = await this.prisma.db.product.findMany({
      where,
      orderBy: this.buildOrderBy(query.sort),
      take: query.limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        shopId: true,
        name: true,
        sku: true,
        title: true,
        price: true,
        currency: true,
        stock: true,
        status: true,
        imageAssetIds: true,
        updatedAt: true,
        shop: { select: { name: true } },
        coverAsset: { select: { objectKey: true, visibility: true, derivatives: true } },
      },
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;

    // 列表读缩略图。签名 URL 由 AssetUrlService 走 Redis 缓存,不会每行都重新签名。
    const coverUrls = await Promise.all(
      items.map((row) => (row.coverAsset ? this.urls.thumbUrl(row.coverAsset) : null)),
    );

    return {
      items: items.map((row, index) => this.toSummary(row, coverUrls[index] ?? null)),
      nextCursor: hasMore ? encodeCursor({ id: items[items.length - 1]?.id ?? '' }) : null,
      hasMore,
    };
  }

  async detail(user: AuthUser, id: string): Promise<ProductDetail> {
    const product = await this.prisma.db.product.findFirst({
      where: { id, ownerId: user.id, deletedAt: null },
      include: {
        shop: { select: { name: true } },
        coverAsset: { select: { objectKey: true, visibility: true, derivatives: true } },
      },
    });
    if (!product) throw AppException.notOwner();

    const coverUrl = product.coverAsset ? await this.urls.thumbUrl(product.coverAsset) : null;

    // 图片一次批量取,按 imageAssetIds 的顺序还原
    const assets =
      product.imageAssetIds.length > 0
        ? await this.prisma.db.asset.findMany({
            where: { id: { in: product.imageAssetIds }, ownerId: user.id },
            select: ASSET_URL_SELECT,
          })
        : [];
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));

    const images = await Promise.all(
      product.imageAssetIds.flatMap((assetId) => {
        const asset = assetById.get(assetId);
        if (!asset) return [];
        return [
          (async () => ({
            assetId,
            url: await this.urls.signObjectKey(asset.objectKey, asset.visibility === 'PUBLIC'),
            previewUrl: await this.urls.previewUrl(asset),
            width: asset.width,
            height: asset.height,
          }))(),
        ];
      }),
    );

    return {
      ...this.toSummary(product, coverUrl),
      description: product.description,
      attributes: toAttributes(product.attributes),
      images,
      createdAt: product.createdAt.toISOString(),
    };
  }

  /**
   * 文案页面用的轻量商品选择列表,只返回自己的商品。
   * 归档商品不参与文案生成,因此不出现在选择器里。
   */
  async options(user: AuthUser, query: { q?: string; limit: number }): Promise<ProductOption[]> {
    const rows = await this.prisma.db.product.findMany({
      where: {
        ownerId: user.id,
        deletedAt: null,
        status: { not: ProductStatus.ARCHIVED },
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { sku: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, name: true, sku: true, shop: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: query.limit,
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      shopName: row.shop.name,
    }));
  }

  // ---------------------------------------------------------------------------
  // 写入
  // ---------------------------------------------------------------------------

  async create(
    user: AuthUser,
    input: ProductCreateInput,
    meta: ClientMeta,
  ): Promise<ProductDetail> {
    // 商品必须落在当前用户自己的店铺下
    const shop = await this.shops.mustOwn(user, input.shopId);

    const imageIds = unique(input.imageAssetIds);
    const referenced = unique([...imageIds, ...(input.coverAssetId ? [input.coverAssetId] : [])]);
    if (referenced.length > 0) {
      await this.assets.assertOwnedActive(user.id, referenced, PRODUCT_IMAGE_KINDS);
    }

    let created: Product;
    try {
      created = await this.prisma.db.product.create({
        data: {
          ownerId: user.id,
          shopId: shop.id,
          name: input.name,
          sku: normalizeSku(input.sku),
          title: input.title ?? null,
          description: input.description ?? null,
          price: input.price ?? null,
          currency: input.currency.toUpperCase(),
          stock: input.stock,
          status: input.status,
          attributes: input.attributes,
          coverAssetId: input.coverAssetId ?? null,
          imageAssetIds: imageIds,
        },
      });
    } catch (err) {
      throw this.mapWriteError(err);
    }

    // 生图结果保存到商品时复用同一 Asset,只加引用计数,不复制文件
    await this.assets.addRefs(referenced, 1);

    await this.audit.record({
      actor: user,
      action: 'product.create',
      targetType: 'Product',
      targetId: created.id,
      metadata: { shopId: shop.id, name: created.name, sku: created.sku },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.detail(user, created.id);
  }

  async update(
    user: AuthUser,
    id: string,
    input: ProductUpdateInput,
    meta: ClientMeta,
  ): Promise<ProductDetail> {
    const before = await this.mustOwn(user, id);

    let shopId = before.shopId;
    if (input.shopId && input.shopId !== before.shopId) {
      // 移动商品同样要校验目标店铺属于当前用户
      const target = await this.shops.mustOwn(user, input.shopId);
      shopId = target.id;
    }

    const nextImages = input.imageAssetIds ? unique(input.imageAssetIds) : before.imageAssetIds;
    const nextCover =
      input.coverAssetId !== undefined ? (input.coverAssetId ?? null) : before.coverAssetId;

    const beforeRefs = new Set(
      unique([...before.imageAssetIds, ...(before.coverAssetId ? [before.coverAssetId] : [])]),
    );
    const afterRefs = new Set(unique([...nextImages, ...(nextCover ? [nextCover] : [])]));
    const added = [...afterRefs].filter((assetId) => !beforeRefs.has(assetId));
    const removed = [...beforeRefs].filter((assetId) => !afterRefs.has(assetId));

    if (added.length > 0) {
      await this.assets.assertOwnedActive(user.id, added, PRODUCT_IMAGE_KINDS);
    }

    const data: Prisma.ProductUncheckedUpdateInput = {
      ...(shopId !== before.shopId ? { shopId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.sku !== undefined ? { sku: normalizeSku(input.sku) } : {}),
      ...(input.title !== undefined ? { title: input.title ?? null } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.price !== undefined ? { price: input.price ?? null } : {}),
      ...(input.currency !== undefined ? { currency: input.currency.toUpperCase() } : {}),
      ...(input.stock !== undefined ? { stock: input.stock } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
      ...(input.coverAssetId !== undefined ? { coverAssetId: nextCover } : {}),
      ...(input.imageAssetIds !== undefined ? { imageAssetIds: nextImages } : {}),
    };

    let after: Product;
    try {
      after = await this.prisma.db.product.update({ where: { id: before.id }, data });
    } catch (err) {
      throw this.mapWriteError(err);
    }

    // 引用计数:新增 +1,移除 -1。refCount 归零后资产才可能进入回收流程。
    await this.assets.addRefs(added, 1);
    await this.assets.addRefs(removed, -1);

    await this.audit.record({
      actor: user,
      action: 'product.update',
      targetType: 'Product',
      targetId: after.id,
      diff: this.audit.buildDiff({ ...before }, { ...after }),
      metadata: { addedImages: added.length, removedImages: removed.length },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.detail(user, after.id);
  }

  /** 删除商品(软删),同时释放图片引用计数 */
  async remove(user: AuthUser, id: string, meta: ClientMeta): Promise<void> {
    const product = await this.mustOwn(user, id);

    await this.prisma.db.product.update({
      where: { id: product.id },
      data: { deletedAt: new Date() },
    });

    const referenced = unique([
      ...product.imageAssetIds,
      ...(product.coverAssetId ? [product.coverAssetId] : []),
    ]);
    await this.assets.addRefs(referenced, -1);

    await this.audit.record({
      actor: user,
      action: 'product.delete',
      targetType: 'Product',
      targetId: product.id,
      metadata: { shopId: product.shopId, name: product.name, releasedImages: referenced.length },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  // ---------------------------------------------------------------------------

  async mustOwn(user: AuthUser, id: string): Promise<Product> {
    const product = await this.prisma.db.product.findFirst({
      where: { id, ownerId: user.id, deletedAt: null },
    });
    if (!product) throw AppException.notOwner();
    return product;
  }

  private buildOrderBy(sort: ProductListQuery['sort']): Prisma.ProductOrderByWithRelationInput[] {
    switch (sort) {
      case 'created_desc':
        return [{ createdAt: 'desc' }, { id: 'desc' }];
      case 'name_asc':
        return [{ name: 'asc' }, { id: 'desc' }];
      case 'price_asc':
        return [{ price: 'asc' }, { id: 'desc' }];
      case 'price_desc':
        return [{ price: 'desc' }, { id: 'desc' }];
      case 'updated_desc':
      default:
        return [{ updatedAt: 'desc' }, { id: 'desc' }];
    }
  }

  private mapWriteError(err: unknown): unknown {
    if (isUniqueViolation(err)) {
      return AppException.conflict(
        ERROR_CODES.PRODUCT_SKU_DUPLICATE,
        '同一店铺下 SKU 不能重复,请修改 SKU 后重试',
      );
    }
    return err;
  }

  private toSummary(row: ProductRow, coverUrl: string | null): ProductSummary {
    return {
      id: row.id,
      shopId: row.shopId,
      shopName: row.shop.name,
      name: row.name,
      sku: row.sku,
      title: row.title,
      // 金额用字符串返回,禁止转 number(0 也必须原样返回)
      price: row.price === null ? null : row.price.toString(),
      currency: row.currency,
      stock: row.stock,
      status: row.status,
      coverUrl,
      imageCount: row.imageAssetIds.length,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** 空 SKU 统一存 null,避免空字符串在 @@unique([shopId, sku]) 上互相冲突 */
function normalizeSku(sku: string | null | undefined): string | null {
  const trimmed = sku?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** attributes 是 Json 列,读回来时做一次防御性收敛,只保留字符串键值 */
export function toAttributes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
