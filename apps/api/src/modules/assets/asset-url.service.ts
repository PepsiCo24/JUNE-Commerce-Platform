import { Injectable } from '@nestjs/common';
import type { Asset } from '@june/db';
import type { AssetView, DerivativeName } from '@june/shared';

import { RedisService } from '../../infra/redis/redis.service';
import { S3Service } from '../storage/s3.service';
import { loadEnv } from '../../config/env';

/** derivatives JSON 字段的结构 */
export interface DerivativeEntry {
  key: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}
export type DerivativeMap = Partial<Record<DerivativeName, DerivativeEntry>>;

/**
 * 资产访问地址生成。
 *
 * 规则:
 *  - PUBLIC(已发布帖子的图):优先返回公共前缀直连地址,可被 CDN / 浏览器长期缓存。
 *  - PRIVATE(店铺图、参考图、生成结果):一律返回短时签名 URL。
 *  - 签名 URL 在 Redis 缓存到剩余有效期的 60%,避免同一列表页反复签名带来的 CPU 开销,
 *    同时保证不会把快过期的 URL 发给前端。
 */
@Injectable()
export class AssetUrlService {
  private readonly env = loadEnv();

  constructor(
    private readonly s3: S3Service,
    private readonly redis: RedisService,
  ) {}

  /** 为任意对象键生成访问地址(私有走签名) */
  async signObjectKey(objectKey: string, isPublic = false): Promise<string> {
    if (isPublic) {
      const direct = this.s3.publicUrl(objectKey);
      if (direct) return direct;
    }

    const cacheKey = `asset:url:${objectKey}`;
    const cached = await this.redis.getJson<{ url: string }>(cacheKey);
    if (cached) return cached.url;

    const url = await this.s3.presignDownload({ objectKey });
    // 只缓存到有效期的 60%,留足余量
    await this.redis.setJson(cacheKey, { url }, Math.floor(this.env.S3_SIGNED_URL_TTL_SECONDS * 0.6));
    return url;
  }

  /** 下载用地址(带 Content-Disposition,不缓存以便使用正确的文件名) */
  async signDownloadUrl(objectKey: string, fileName: string): Promise<string> {
    return this.s3.presignDownload({ objectKey, downloadFileName: fileName });
  }

  parseDerivatives(asset: Pick<Asset, 'derivatives'>): DerivativeMap {
    const raw = asset.derivatives;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as DerivativeMap;
  }

  /**
   * 生成前端使用的资产视图。列表读 thumb、详情读 preview、下载读原图。
   * 派生图尚未生成时回落到原图,以避免出现破图。
   */
  async toView(asset: Asset): Promise<AssetView> {
    const isPublic = asset.visibility === 'PUBLIC';
    const derivatives = this.parseDerivatives(asset);

    const [url, thumbUrl, previewUrl] = await Promise.all([
      this.signObjectKey(asset.objectKey, isPublic),
      derivatives.thumb ? this.signObjectKey(derivatives.thumb.key, isPublic) : null,
      derivatives.preview ? this.signObjectKey(derivatives.preview.key, isPublic) : null,
    ]);

    return {
      id: asset.id,
      kind: asset.kind,
      status: asset.status,
      visibility: asset.visibility,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
      url,
      thumbUrl: thumbUrl ?? url,
      previewUrl: previewUrl ?? url,
      derivativeStatus: asset.derivativeStatus as AssetView['derivativeStatus'],
      createdAt: asset.createdAt.toISOString(),
    };
  }

  /** 批量生成,避免 N+1 次签名调用串行执行 */
  async toViews(assets: Asset[]): Promise<AssetView[]> {
    return Promise.all(assets.map((a) => this.toView(a)));
  }

  /** 只取缩略图地址(列表场景,减少不必要的签名) */
  async thumbUrl(asset: Pick<Asset, 'objectKey' | 'visibility' | 'derivatives'>): Promise<string> {
    const isPublic = asset.visibility === 'PUBLIC';
    const derivatives = this.parseDerivatives(asset);
    const key = derivatives.thumb?.key ?? asset.objectKey;
    return this.signObjectKey(key, isPublic);
  }

  async previewUrl(asset: Pick<Asset, 'objectKey' | 'visibility' | 'derivatives'>): Promise<string> {
    const isPublic = asset.visibility === 'PUBLIC';
    const derivatives = this.parseDerivatives(asset);
    const key = derivatives.preview?.key ?? asset.objectKey;
    return this.signObjectKey(key, isPublic);
  }
}
