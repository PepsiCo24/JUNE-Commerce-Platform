import { Injectable, Logger } from '@nestjs/common';
import { AssetKind, AssetStatus, AssetVisibility, type Asset } from '@june/db';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ERROR_CODES,
  formatBytes,
  type AssetView,
  type StorageUsageView,
  type UploadTicketRequest,
  type UploadTicketResponse,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { QueueProducerService } from '../queue/queue-producer.service';
import { S3Service } from '../storage/s3.service';
import { AssetUrlService } from './asset-url.service';

/** 各用途的默认可见性。公开帖子图可走公共缓存,其余默认私有。 */
const KIND_VISIBILITY: Record<AssetKind, AssetVisibility> = {
  POST_IMAGE: AssetVisibility.PUBLIC,
  AVATAR: AssetVisibility.PUBLIC,
  PRODUCT_IMAGE: AssetVisibility.PRIVATE,
  SHOP_IMAGE: AssetVisibility.PRIVATE,
  REFERENCE_IMAGE: AssetVisibility.PRIVATE,
  GENERATED_IMAGE: AssetVisibility.PRIVATE,
  IMPORT_FILE: AssetVisibility.PRIVATE,
};

/** 文件头魔数校验表:防止把可执行文件改扩展名当图片上传 */
const MAGIC_BYTES: Array<{ mime: string; test: (buf: Buffer) => boolean }> = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/gif', test: (b) => b.subarray(0, 3).toString('ascii') === 'GIF' },
  {
    mime: 'image/webp',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mime: 'image/avif',
    test: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp' && b.subarray(8, 12).toString('ascii').includes('av'),
  },
];

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly crypto: CryptoService,
    private readonly urls: AssetUrlService,
    private readonly queue: QueueProducerService,
  ) {}

  // ---------------------------------------------------------------------------
  // 直传:签发 -> 浏览器 PUT -> 确认
  // ---------------------------------------------------------------------------

  /**
   * 签发直传凭证。
   * 上传前检查存储配额,避免用户先传完才发现超额。
   */
  async createUploadTicket(user: AuthUser, input: UploadTicketRequest): Promise<UploadTicketResponse> {
    if (input.byteSize > this.env.UPLOAD_MAX_BYTES) {
      throw AppException.payloadTooLarge(
        `单个文件不能超过 ${formatBytes(this.env.UPLOAD_MAX_BYTES)}`,
      );
    }

    const kind = input.kind as AssetKind;
    await this.assertQuota(user.id, input.byteSize);

    // 同一用户内去重:相同 sha256 + 相同用途,直接复用已有资产
    if (input.sha256) {
      const existing = await this.prisma.db.asset.findFirst({
        where: {
          ownerId: user.id,
          sha256: input.sha256,
          kind,
          status: { in: [AssetStatus.ACTIVE, AssetStatus.ORPHAN] },
        },
      });
      if (existing) {
        // 曾被标记为孤儿的资产在被复用时恢复为可用
        if (existing.status === AssetStatus.ORPHAN) {
          await this.prisma.db.asset.update({
            where: { id: existing.id },
            data: { status: AssetStatus.ACTIVE },
          });
        }
        return {
          assetId: existing.id,
          method: 'PUT',
          uploadUrl: '',
          headers: {},
          objectKey: existing.objectKey,
          expiresAt: new Date().toISOString(),
          maxBytes: this.env.UPLOAD_MAX_BYTES,
          deduplicated: true,
        };
      }
    }

    const objectKey = this.buildObjectKey(user.id, kind, input.originalName ?? '');
    const { url, headers, expiresIn } = await this.s3.presignUpload({
      objectKey,
      contentType: input.mimeType,
    });

    const asset = await this.prisma.db.asset.create({
      data: {
        ownerId: user.id,
        kind,
        status: AssetStatus.PENDING,
        visibility: KIND_VISIBILITY[kind],
        objectKey,
        bucket: this.s3.bucket,
        mimeType: input.mimeType,
        // 声明值,confirm 阶段会用对象存储的实际值覆盖
        byteSize: input.byteSize,
        sha256: input.sha256 ?? null,
        originalName: input.originalName?.slice(0, 300) ?? null,
        derivativeStatus: 'pending',
      },
    });

    return {
      assetId: asset.id,
      method: 'PUT',
      uploadUrl: url,
      headers,
      objectKey,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      maxBytes: this.env.UPLOAD_MAX_BYTES,
      deduplicated: false,
    };
  }

  /**
   * 确认上传。这是安全关键路径:
   *  1. 校验资产归属(只能确认自己的);
   *  2. 回查对象存储的**实际**大小与类型,而不是相信客户端声明;
   *  3. 用文件头魔数校验真实图片类型;
   *  4. 复核配额;
   *  5. 入队生成缩略图/预览图。
   */
  async confirmUpload(user: AuthUser, assetId: string): Promise<AssetView> {
    const asset = await this.prisma.db.asset.findFirst({
      where: { id: assetId, ownerId: user.id },
    });
    if (!asset) throw AppException.notOwner();

    if (asset.status === AssetStatus.ACTIVE) {
      return this.urls.toView(asset);
    }
    if (asset.status !== AssetStatus.PENDING) {
      throw AppException.badRequest(ERROR_CODES.UPLOAD_NOT_CONFIRMED, '该文件状态不允许确认');
    }

    const meta = await this.s3.head(asset.objectKey);
    if (!meta) {
      throw AppException.badRequest(ERROR_CODES.UPLOAD_NOT_CONFIRMED, '尚未检测到上传完成的文件');
    }

    if (meta.contentLength <= 0 || meta.contentLength > this.env.UPLOAD_MAX_BYTES) {
      await this.discardPending(asset);
      throw AppException.payloadTooLarge(`文件大小超出限制(${formatBytes(this.env.UPLOAD_MAX_BYTES)})`);
    }

    // 声明大小与实际差异过大视为不一致(允许少量协议开销差异)
    if (Math.abs(meta.contentLength - asset.byteSize) > 1024) {
      this.logger.warn(
        `资产 ${asset.id} 声明大小 ${asset.byteSize} 与实际 ${meta.contentLength} 不一致,按实际值记账`,
      );
    }

    const isImage = asset.kind !== AssetKind.IMPORT_FILE;
    if (isImage) {
      const head = await this.s3.readRange(asset.objectKey, 32);
      if (!head || !this.detectImageMime(head)) {
        await this.discardPending(asset);
        throw AppException.badRequest(
          ERROR_CODES.UPLOAD_CONTENT_MISMATCH,
          '文件内容不是受支持的图片格式',
        );
      }
      const detected = this.detectImageMime(head);
      if (detected && !ALLOWED_IMAGE_MIME_TYPES.includes(detected as (typeof ALLOWED_IMAGE_MIME_TYPES)[number])) {
        await this.discardPending(asset);
        throw AppException.badRequest(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, '不支持该图片格式');
      }
      // 以实际检测到的类型为准,避免客户端谎报 Content-Type
      if (detected && detected !== asset.mimeType) {
        this.logger.warn(`资产 ${asset.id} 声明类型 ${asset.mimeType},实际为 ${detected},按实际值记录`);
      }
    }

    await this.assertQuota(user.id, meta.contentLength);

    const updated = await this.prisma.db.$transaction(async (tx) => {
      const next = await tx.asset.update({
        where: { id: asset.id },
        data: {
          status: AssetStatus.ACTIVE,
          byteSize: meta.contentLength,
          confirmedAt: new Date(),
          derivativeStatus: isImage ? 'pending' : 'skipped',
        },
      });
      await tx.storageUsage.update({
        where: { userId: user.id },
        data: {
          bytesUsed: { increment: BigInt(meta.contentLength) },
          assetCount: { increment: 1 },
        },
      });
      return next;
    });

    if (isImage) {
      // 缩略图/预览图交给 Worker,API 不同步做大图压缩
      await this.queue.enqueueDeriveImage({ assetId: updated.id, ownerId: user.id });
    }

    return this.urls.toView(updated);
  }

  private detectImageMime(head: Buffer): string | null {
    for (const entry of MAGIC_BYTES) {
      try {
        if (entry.test(head)) return entry.mime;
      } catch {
        // 缓冲区不足时忽略该规则
      }
    }
    return null;
  }

  /** 丢弃未通过校验的待确认资产,并尽力清除已上传的对象 */
  private async discardPending(asset: Asset): Promise<void> {
    await this.prisma.db.asset.update({
      where: { id: asset.id },
      data: { status: AssetStatus.ORPHAN },
    });
    try {
      await this.s3.delete(asset.objectKey);
    } catch (err) {
      this.logger.warn(`清除无效上传对象失败 ${asset.objectKey}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 归属校验与引用计数
  // ---------------------------------------------------------------------------

  /**
   * 校验一批资产都属于该用户且可用。业务在关联图片前必须调用,
   * 否则会出现"引用他人私有图片"的越权。
   */
  async assertOwnedActive(userId: string, assetIds: string[], kinds?: AssetKind[]): Promise<Asset[]> {
    if (assetIds.length === 0) return [];

    const unique = [...new Set(assetIds)];
    const assets = await this.prisma.db.asset.findMany({
      where: {
        id: { in: unique },
        ownerId: userId,
        status: AssetStatus.ACTIVE,
        ...(kinds ? { kind: { in: kinds } } : {}),
      },
    });

    if (assets.length !== unique.length) {
      throw AppException.badRequest(ERROR_CODES.NOT_FOUND, '部分图片不存在、尚未上传完成或不属于你');
    }

    // 保持调用方传入的顺序
    const byId = new Map(assets.map((a) => [a.id, a]));
    return unique.map((id) => byId.get(id)!);
  }

  /**
   * 调整引用计数。业务保存/解绑图片时调用。
   * refCount > 0 的资产永不物理删除,这样"删除帖子"不会破坏商品里复用的同一张图。
   */
  async addRefs(assetIds: string[], delta: number): Promise<void> {
    if (assetIds.length === 0 || delta === 0) return;
    await this.prisma.db.asset.updateMany({
      where: { id: { in: [...new Set(assetIds)] } },
      data: { refCount: { increment: delta } },
    });
  }

  /** 把生成结果保存到商品/帖子时复用同一 Asset 引用,不做物理复制 */
  async reuseForBusiness(userId: string, assetIds: string[]): Promise<Asset[]> {
    const assets = await this.assertOwnedActive(userId, assetIds);
    await this.addRefs(assetIds, 1);
    return assets;
  }

  /**
   * 删除资产:进入回收期而非立即物理删除。
   * 仍有业务引用时直接拒绝,避免破坏有效商品与帖子。
   */
  async recycle(user: AuthUser, assetId: string): Promise<void> {
    const asset = await this.prisma.db.asset.findFirst({ where: { id: assetId, ownerId: user.id } });
    if (!asset) throw AppException.notOwner();

    if (asset.refCount > 0) {
      throw AppException.conflict(ERROR_CODES.ASSET_IN_USE);
    }
    if (asset.status === AssetStatus.RECYCLED || asset.status === AssetStatus.PURGED) return;

    await this.prisma.db.$transaction(async (tx) => {
      await tx.asset.update({
        where: { id: asset.id },
        data: { status: AssetStatus.RECYCLED, recycledAt: new Date() },
      });
      if (asset.status === AssetStatus.ACTIVE) {
        await tx.storageUsage.update({
          where: { userId: user.id },
          data: {
            bytesUsed: { decrement: BigInt(asset.byteSize) },
            assetCount: { decrement: 1 },
            recycledBytes: { increment: BigInt(asset.byteSize) },
          },
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 配额
  // ---------------------------------------------------------------------------

  private async assertQuota(userId: string, additionalBytes: number): Promise<void> {
    const usage = await this.prisma.db.storageUsage.upsert({
      where: { userId },
      create: { userId, quotaBytes: BigInt(this.env.DEFAULT_STORAGE_QUOTA_BYTES) },
      update: {},
    });

    if (usage.bytesUsed + BigInt(additionalBytes) > usage.quotaBytes) {
      throw AppException.badRequest(
        ERROR_CODES.QUOTA_EXCEEDED,
        `存储空间不足:已用 ${formatBytes(usage.bytesUsed)} / 配额 ${formatBytes(usage.quotaBytes)}`,
      );
    }
  }

  async getUsage(userId: string): Promise<StorageUsageView> {
    const usage = await this.prisma.db.storageUsage.upsert({
      where: { userId },
      create: { userId, quotaBytes: BigInt(this.env.DEFAULT_STORAGE_QUOTA_BYTES) },
      update: {},
    });

    const since = new Date(Date.now() - 30 * 86_400_000);
    const growth = await this.prisma.db.asset.aggregate({
      where: { ownerId: userId, status: AssetStatus.ACTIVE, confirmedAt: { gte: since } },
      _sum: { byteSize: true },
    });

    const used = Number(usage.bytesUsed);
    const quota = Number(usage.quotaBytes);

    return {
      bytesUsed: usage.bytesUsed.toString(),
      quotaBytes: usage.quotaBytes.toString(),
      assetCount: usage.assetCount,
      recycledBytes: usage.recycledBytes.toString(),
      usedPercent: quota > 0 ? Math.min(100, Math.round((used / quota) * 1000) / 10) : 0,
      growthBytes30d: String(growth._sum.byteSize ?? 0),
    };
  }

  // ---------------------------------------------------------------------------

  private buildObjectKey(userId: string, kind: AssetKind, originalName: string): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const random = this.crypto.randomToken(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 16);

    const ext = (originalName.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin').toLowerCase();
    const folder = kind.toLowerCase();

    // 按用户与月份分片,便于按用户统计与按时间清理
    return `u/${userId}/${folder}/${yyyy}${mm}/${random}.${ext}`;
  }

  /** 获取单个资产(带归属校验),供下载接口使用 */
  async getOwnedAsset(userId: string, assetId: string): Promise<Asset> {
    const asset = await this.prisma.db.asset.findFirst({
      where: { id: assetId, ownerId: userId, status: { in: [AssetStatus.ACTIVE, AssetStatus.RECYCLED] } },
    });
    if (!asset) throw AppException.notOwner();
    return asset;
  }
}
