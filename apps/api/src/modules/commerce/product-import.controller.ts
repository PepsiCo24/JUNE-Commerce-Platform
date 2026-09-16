import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  idSchema,
  productImportCommitSchema,
  productImportPreviewSchema,
  type ImportJobStatus,
  type ProductImportCommitInput,
  type ProductImportPreview,
} from '@june/shared';
import type { Response } from 'express';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/validation/zod-body.pipe';
import type { ClientMeta, ImportEnqueueResult } from './commerce.types';
import { ProductImportService, type ProductImportPreviewInput } from './product-import.service';

/**
 * 商品 CSV 导入。
 *
 * 路径都在 products/import 之下(两段路径),与 GET /products/:id 不冲突。
 */
@Controller('products/import')
export class ProductImportController {
  constructor(private readonly imports: ProductImportService) {}

  /** 下载 CSV 模板。带 UTF-8 BOM,Excel 打开中文不乱码。 */
  @Get('template')
  template(@Res() res: Response): void {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent('商品导入模板.csv')}`,
    );
    // 模板是固定内容,但仍不缓存:后续列有调整时用户不会拿到旧模板
    res.setHeader('Cache-Control', 'no-store');
    res.send(this.imports.buildTemplate());
  }

  /** 预览:只解析与校验,不写入任何业务数据 */
  @Post('preview')
  @HttpCode(200)
  async preview(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(productImportPreviewSchema)) dto: ProductImportPreviewInput,
  ): Promise<ProductImportPreview> {
    return this.imports.preview(user, dto);
  }

  /** 提交导入:创建作业并入队,立刻返回 jobId。逐行入库由 Worker 执行。 */
  @Post()
  @HttpCode(202)
  async commit(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(productImportCommitSchema)) dto: ProductImportCommitInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<ImportEnqueueResult> {
    return this.imports.commit(user, dto, meta);
  }

  /** 作业状态与逐行错误,只能查自己的作业 */
  @Get(':jobId')
  async status(
    @CurrentUser() user: AuthUser,
    @Param('jobId', zodBody(idSchema)) jobId: string,
  ): Promise<ImportJobStatus> {
    return this.imports.status(user, jobId);
  }
}
