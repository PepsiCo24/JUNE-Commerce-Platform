import { z } from 'zod';

import { ALLOWED_IMAGE_MIME_TYPES, ALLOWED_IMPORT_MIME_TYPES } from '../constants';
import { idSchema } from './common';

export const ASSET_KINDS = [
  'POST_IMAGE',
  'PRODUCT_IMAGE',
  'SHOP_IMAGE',
  'AVATAR',
  'REFERENCE_IMAGE',
  'GENERATED_IMAGE',
  'IMPORT_FILE',
] as const;
export type AssetKindValue = (typeof ASSET_KINDS)[number];

/** 用户可直接申请上传的类型。GENERATED_IMAGE 只能由 Worker 转存产生。 */
export const UPLOADABLE_ASSET_KINDS = [
  'POST_IMAGE',
  'PRODUCT_IMAGE',
  'SHOP_IMAGE',
  'AVATAR',
  'REFERENCE_IMAGE',
  'IMPORT_FILE',
] as const;

/**
 * 申请直传凭证。浏览器凭后端签发的短时凭证直传对象存储,
 * 后端在 confirm 阶段核验实际内容、大小与归属后才允许关联业务。
 */
export const uploadTicketRequestSchema = z
  .object({
    kind: z.enum(UPLOADABLE_ASSET_KINDS),
    /** 声明的 MIME 类型,confirm 阶段会与对象存储实际内容比对 */
    mimeType: z.string().min(3).max(120),
    /** 声明的字节数,用于预检配额,confirm 阶段会与实际大小比对 */
    byteSize: z.number().int().min(1),
    originalName: z.string().max(300).optional(),
    /** 客户端计算的 sha256(hex),用于同用户去重。可选 */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'sha256 需为 64 位小写十六进制')
      .optional(),
  })
  .superRefine((value, ctx) => {
    const imageKinds = new Set(['POST_IMAGE', 'PRODUCT_IMAGE', 'SHOP_IMAGE', 'AVATAR', 'REFERENCE_IMAGE']);
    const allowed: readonly string[] = imageKinds.has(value.kind)
      ? ALLOWED_IMAGE_MIME_TYPES
      : ALLOWED_IMPORT_MIME_TYPES;
    if (!allowed.includes(value.mimeType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mimeType'],
        message: `该用途仅支持:${allowed.join('、')}`,
      });
    }
  });
export type UploadTicketRequest = z.infer<typeof uploadTicketRequestSchema>;

export interface UploadTicketResponse {
  /** 预创建的 Asset id(状态为 PENDING) */
  assetId: string;
  /** 直传方式:presigned PUT */
  method: 'PUT';
  uploadUrl: string;
  /** 必须原样带上的请求头(如 Content-Type) */
  headers: Record<string, string>;
  objectKey: string;
  expiresAt: string;
  maxBytes: number;
  /** 命中同用户去重时直接返回已有资产,前端可跳过上传 */
  deduplicated: boolean;
}

export const uploadConfirmSchema = z.object({
  assetId: idSchema,
});

export interface AssetView {
  id: string;
  kind: AssetKindValue;
  status: 'PENDING' | 'ACTIVE' | 'ORPHAN' | 'RECYCLED' | 'PURGED';
  visibility: 'PUBLIC' | 'PRIVATE';
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  /** 原图访问地址(私有资源为短时签名 URL) */
  url: string;
  /** 列表用缩略图 */
  thumbUrl: string | null;
  /** 详情用预览图(优先 WebP) */
  previewUrl: string | null;
  derivativeStatus: 'pending' | 'ready' | 'failed' | 'skipped';
  createdAt: string;
}

export interface StorageUsageView {
  bytesUsed: string;
  quotaBytes: string;
  assetCount: number;
  recycledBytes: string;
  usedPercent: number;
  /** 近 30 天增长(字节) */
  growthBytes30d: string;
}
