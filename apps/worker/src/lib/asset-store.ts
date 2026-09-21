/**
 * 生成结果转存。
 *
 * 为什么必须转存:各家供应商返回的图片链接都是短时签名 URL
 * (limits.resultUrlTtlSeconds,常见 1~24 小时)。如果直接把这个链接存进数据库当访问入口,
 * 用户第二天再打开"我的生成记录"就是一片裂图。因此:
 *   上游拿到图 -> 立刻下载 -> 上传到本平台对象存储 -> 建 Asset -> providerRefUrl 只做溯源。
 *
 * 同时要守住存储配额:超配额时把该结果标记失败并给出明确错误,
 * **不静默丢弃**、也不悄悄超卖磁盘。
 */
import { createHash } from 'node:crypto';

import { AssetKind, AssetStatus, AssetVisibility, type Asset } from '@june/db';
import { ERROR_CODES, formatBytes } from '@june/shared';
import sharp from 'sharp';

import { loadEnv } from '../config/env';
import { createLogger } from './logger';
import { getPrisma } from './prisma';
import { enqueueDeriveImage } from './queues';
import { getS3 } from './s3';
import { publishStorageUpdated } from './sse-publisher';

const log = createLogger('asset-store');

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export class QuotaExceededError extends Error {
  readonly errorCode = ERROR_CODES.QUOTA_EXCEEDED;
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export class ResultTooLargeError extends Error {
  readonly errorCode = ERROR_CODES.FILE_TOO_LARGE;
  constructor(message: string) {
    super(message);
    this.name = 'ResultTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

/**
 * 下载上游图片。带体积上限,防止上游返回超大文件把 Worker 内存打爆。
 * 只允许 http/https:供应商 baseUrl 已在后台配置时做过内网白名单校验
 * (PROVIDER_URL_ALLOW_PRIVATE_NETWORK),这里再挡一次协议。
 */
export async function downloadImage(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的图片链接协议:${parsed.protocol}`);
  }

  const res = await fetch(url, { ...(signal ? { signal } : {}) });
  if (!res.ok) {
    throw new Error(`下载生成结果失败:HTTP ${res.status}`);
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    throw new ResultTooLargeError(
      `生成结果 ${formatBytes(declared)} 超过单文件上限 ${formatBytes(maxBytes)}`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new ResultTooLargeError(
      `生成结果 ${formatBytes(buffer.byteLength)} 超过单文件上限 ${formatBytes(maxBytes)}`,
    );
  }
  return buffer;
}

/** 上游直接给 base64 时的解码路径(不含 data URI 前缀,兼容带前缀的情况) */
export function decodeBase64Image(base64: string): Buffer {
  const cleaned = base64.replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(cleaned, 'base64');
}

// ---------------------------------------------------------------------------
// 存入
// ---------------------------------------------------------------------------

export interface StoredResultAsset {
  asset: Asset;
  /** 命中同用户去重时为 true(不重复计入配额) */
  reused: boolean;
  width: number | null;
  height: number | null;
  byteSize: number;
}

/**
 * 把生成图写进对象存储 + Asset 表。
 *
 * 步骤顺序有意为之:
 *  1. 先用 sharp 读真实宽高与 MIME(不信任上游声明的 mimeType);
 *  2. 先查同用户 sha256 去重——同一张图不重复占配额,也不重复上传;
 *  3. 上传前检查配额,避免"传完才发现超额"白花流量;
 *  4. 上传对象;
 *  5. 在一个事务里建 Asset + 累加 StorageUsage,保证用量与资产不会对不上;
 *  6. 入队派生图。
 */
export async function storeGeneratedImage(params: {
  ownerId: string;
  body: Buffer;
  /** 上游声明的 MIME,仅作参考 */
  declaredMimeType: string;
  originalName?: string;
}): Promise<StoredResultAsset> {
  const env = loadEnv();
  const prisma = getPrisma();
  const s3 = getS3();

  if (params.body.byteLength === 0) throw new Error('上游返回了空图片');
  if (params.body.byteLength > env.UPLOAD_MAX_BYTES) {
    throw new ResultTooLargeError(
      `生成结果 ${formatBytes(params.body.byteLength)} 超过单文件上限 ${formatBytes(env.UPLOAD_MAX_BYTES)}`,
    );
  }

  // 1. 用 sharp 读真实元信息
  let width: number | null = null;
  let height: number | null = null;
  let mimeType = params.declaredMimeType;
  try {
    const metadata = await sharp(params.body, { failOn: 'none' }).metadata();
    width = metadata.width ?? null;
    height = metadata.height ?? null;
    if (metadata.format) {
      const detected = metadata.format;
      mimeType = `image/${detected}`;
    }
  } catch (err) {
    // 读不出元信息说明不是可识别图片,直接拒绝,不要把坏数据写进资产库
    throw new Error(`生成结果不是可识别的图片:${(err as Error).message}`);
  }

  const byteSize = params.body.byteLength;
  const sha256 = createHash('sha256').update(params.body).digest('hex');

  // 2. 同用户 + 同 sha256 + 同用途去重(与 Asset 的 @@unique([ownerId, sha256, kind]) 对齐)
  const existing = await prisma.asset.findFirst({
    where: {
      ownerId: params.ownerId,
      sha256,
      kind: AssetKind.GENERATED_IMAGE,
      status: { in: [AssetStatus.ACTIVE, AssetStatus.ORPHAN] },
    },
  });
  if (existing) {
    const revived =
      existing.status === AssetStatus.ORPHAN
        ? await prisma.asset.update({
            where: { id: existing.id },
            data: { status: AssetStatus.ACTIVE },
          })
        : existing;
    log.debug(`生成结果命中同用户去重,复用资产 ${revived.id}`);
    return { asset: revived, reused: true, width: revived.width, height: revived.height, byteSize };
  }

  // 3. 配额检查(超额不静默丢弃,抛出明确错误由调用方写进结果的 errorCode/errorMessage)
  const usage = await prisma.storageUsage.upsert({
    where: { userId: params.ownerId },
    create: { userId: params.ownerId, quotaBytes: BigInt(env.DEFAULT_STORAGE_QUOTA_BYTES) },
    update: {},
  });
  if (usage.bytesUsed + BigInt(byteSize) > usage.quotaBytes) {
    throw new QuotaExceededError(
      `存储空间不足,生成结果未能保存:已用 ${formatBytes(usage.bytesUsed)} / 配额 ${formatBytes(usage.quotaBytes)}`,
    );
  }

  // 4. 上传
  const objectKey = buildGeneratedObjectKey(params.ownerId, mimeType);
  await s3.putBuffer({ objectKey, body: params.body, contentType: mimeType });

  // 5. 建 Asset + 记账(同一事务)
  try {
    const { asset, nextUsage } = await prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({
        data: {
          ownerId: params.ownerId,
          kind: AssetKind.GENERATED_IMAGE,
          status: AssetStatus.ACTIVE,
          // 生成结果属于私有资源,只能通过短时签名 URL 访问
          visibility: AssetVisibility.PRIVATE,
          objectKey,
          bucket: s3.bucket,
          mimeType,
          byteSize,
          width,
          height,
          sha256,
          originalName: params.originalName?.slice(0, 300) ?? null,
          derivativeStatus: 'pending',
          // refCount 保持 0:用户把结果保存到商品/帖子时才 +1。
          // 清理任务据此判断"是否被业务引用",不会因为 refCount=0 就立刻删掉
          // (还有 ASSET_ORPHAN_GRACE_HOURS 宽限期兜底)。
          refCount: 0,
        },
      });
      const updatedUsage = await tx.storageUsage.update({
        where: { userId: params.ownerId },
        data: { bytesUsed: { increment: BigInt(byteSize) }, assetCount: { increment: 1 } },
      });
      return { asset: created, nextUsage: updatedUsage };
    });

    // 6. 派生图交给 image-derive 队列,生图 Worker 不同步做压缩
    await enqueueDeriveImage({ assetId: asset.id, ownerId: params.ownerId });
    await publishStorageUpdated(params.ownerId, {
      bytesUsed: nextUsage.bytesUsed,
      quotaBytes: nextUsage.quotaBytes,
    });

    return { asset, reused: false, width, height, byteSize };
  } catch (err) {
    // 建表失败时把已上传的对象清掉,避免留下没人认领的孤儿文件
    await getS3().deleteQuietly(objectKey);
    throw err;
  }
}

/**
 * 对象键规则与 apps/api 的 AssetsService.buildObjectKey 保持一致:
 * 按用户与月份分片,便于按用户统计与按时间清理。
 */
export function buildGeneratedObjectKey(userId: string, mimeType: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const random = createHash('sha256')
    .update(`${userId}:${now.getTime()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 16);
  const ext = EXT_BY_MIME[mimeType] ?? 'bin';
  return `u/${userId}/${AssetKind.GENERATED_IMAGE.toLowerCase()}/${yyyy}${mm}/${random}.${ext}`;
}
