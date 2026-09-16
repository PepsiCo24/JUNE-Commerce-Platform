import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  idSchema,
  uploadTicketRequestSchema,
  type AssetView,
  type StorageUsageView,
  type UploadTicketRequest,
  type UploadTicketResponse,
} from '@june/shared';
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthUser } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import { loadEnv } from '../../config/env';
import { AssetsService } from './assets.service';
import { AssetUrlService } from './asset-url.service';

const uploadThrottle = {
  default: { limit: loadEnv().RATE_LIMIT_UPLOAD_PER_MINUTE, ttl: 60_000 },
};

const downloadQuerySchema = z.object({
  /** 下载时使用的文件名 */
  fileName: z.string().trim().max(200).optional(),
});

@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly urls: AssetUrlService,
  ) {}

  /**
   * 申请直传凭证。浏览器随后直接 PUT 到对象存储,上传流量不经过 API。
   * 命中同用户去重时 deduplicated=true,前端可跳过上传直接使用返回的 assetId。
   */
  @Throttle(uploadThrottle)
  @Post('upload-ticket')
  @HttpCode(200)
  async createTicket(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(uploadTicketRequestSchema)) dto: UploadTicketRequest,
  ): Promise<UploadTicketResponse> {
    return this.assets.createUploadTicket(user, dto);
  }

  /** 确认上传:后端回查对象存储的实际内容、大小与类型后才置为可用 */
  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<AssetView> {
    return this.assets.confirmUpload(user, id);
  }

  /** 存储用量与配额 */
  @Get('usage')
  async usage(@CurrentUser() user: AuthUser): Promise<StorageUsageView> {
    return this.assets.getUsage(user.id);
  }

  /**
   * 原图下载。私有资源通过后端签发短时 URL 后 302 跳转,
   * 这样既做了归属校验,又不让 API 承载文件传输流量。
   */
  @Get(':id/download')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
    @Query(zodQuery(downloadQuerySchema)) query: z.infer<typeof downloadQuerySchema>,
    @Res() res: Response,
  ): Promise<void> {
    const asset = await this.assets.getOwnedAsset(user.id, id);
    const fallbackName = asset.originalName ?? `${asset.id}.${asset.mimeType.split('/')[1] ?? 'bin'}`;
    const url = await this.urls.signDownloadUrl(asset.objectKey, query.fileName ?? fallbackName);
    res.redirect(302, url);
  }

  /** 删除资产:进入回收期;仍被业务引用时拒绝 */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', zodBody(idSchema)) id: string): Promise<void> {
    await this.assets.recycle(user, id);
  }
}
