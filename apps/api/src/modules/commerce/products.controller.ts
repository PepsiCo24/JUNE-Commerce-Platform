import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  PAGE_SIZE_MAX,
  idSchema,
  productCreateSchema,
  productListQuerySchema,
  productUpdateSchema,
  type CursorResult,
  type ProductCreateInput,
  type ProductDetail,
  type ProductSummary,
  type ProductUpdateInput,
} from '@june/shared';
import { z } from 'zod';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import type { ClientMeta, ProductOption } from './commerce.types';
import { ProductsService, type ProductListQuery } from './products.service';

/** 商品选择器的查询参数。跨端契约里没有这个轻量接口,按 assets 模块的先例就近定义。 */
const productOptionsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(50),
});
type ProductOptionsQuery = z.infer<typeof productOptionsQuerySchema>;

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  /**
   * 文案页面用的轻量商品列表。
   * 必须声明在 :id 之前,否则 "options" 会被当作商品 id。
   */
  @Get('options')
  async options(
    @CurrentUser() user: AuthUser,
    @Query(zodQuery(productOptionsQuerySchema)) query: ProductOptionsQuery,
  ): Promise<ProductOption[]> {
    return this.products.options(user, query);
  }

  /** 商品列表。游标分页。 */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(zodQuery(productListQuerySchema)) query: ProductListQuery,
  ): Promise<CursorResult<ProductSummary>> {
    return this.products.list(user, query);
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<ProductDetail> {
    return this.products.detail(user, id);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(productCreateSchema)) dto: ProductCreateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ProductDetail> {
    return this.products.create(user, dto, meta);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Body(zodBody(productUpdateSchema)) dto: ProductUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ProductDetail> {
    return this.products.update(user, id, dto, meta);
  }

  /** 删除商品(软删),并释放图片引用计数 */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @ClientInfo() meta: ClientMeta,
  ): Promise<void> {
    await this.products.remove(user, id, meta);
  }
}
