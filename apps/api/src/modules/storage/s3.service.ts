import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';

import { loadEnv } from '../../config/env';

export interface ObjectMetadata {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
}

/**
 * 对象存储访问层(S3 兼容:AWS S3 / 阿里云 OSS / 腾讯云 COS / MinIO)。
 *
 * 关键约定:
 *  - 图片二进制永远不经过数据库,数据库只存对象键与元信息。
 *  - 浏览器通过后端签发的短时预签名 URL 直传,API 进程不承载上传流量。
 *  - 私有资源(店铺图、参考图、生成结果)只能通过短时签名 URL 访问;
 *    公开帖子图可走公共前缀以利用 CDN 缓存。
 */
@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly env = loadEnv();
  private readonly client: S3Client;
  readonly bucket: string;

  constructor() {
    this.bucket = this.env.S3_BUCKET;
    this.client = new S3Client({
      region: this.env.S3_REGION,
      endpoint: this.env.S3_ENDPOINT,
      forcePathStyle: this.env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: this.env.S3_ACCESS_KEY_ID,
        secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
      },
      // 单机部署下适度重试即可,过多重试会拖长请求
      maxAttempts: 3,
      // MinIO / 部分兼容实现不接受 SDK 默认的柔性校验和头(会报 Custom Id cannot contain :)
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * 生成直传用的预签名 PUT URL。
   *
   * 注意:预签名 URL 只能约束 URL 本身,**无法**真正强制客户端上传的内容与大小,
   * 因此 confirm 阶段必须回查对象的实际 Content-Length / Content-Type,
   * 见 AssetsService.confirmUpload。
   */
  async presignUpload(params: {
    objectKey: string;
    contentType: string;
  }): Promise<{ url: string; headers: Record<string, string>; expiresIn: number }> {
    const expiresIn = this.env.S3_UPLOAD_URL_TTL_SECONDS;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.objectKey,
      ContentType: params.contentType,
    });

    const url = await getSignedUrl(this.client, command, { expiresIn });
    return { url, headers: { 'Content-Type': params.contentType }, expiresIn };
  }

  /** 私有资源的短时下载 URL */
  async presignDownload(params: {
    objectKey: string;
    /** 触发浏览器下载而非内联预览时传文件名 */
    downloadFileName?: string;
    expiresIn?: number;
  }): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: params.objectKey,
      ...(params.downloadFileName
        ? {
            ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(
              params.downloadFileName,
            )}`,
          }
        : {}),
    });
    return getSignedUrl(this.client, command, {
      expiresIn: params.expiresIn ?? this.env.S3_SIGNED_URL_TTL_SECONDS,
    });
  }

  /** 公开资源的直连地址(仅在配置了公共前缀时可用) */
  publicUrl(objectKey: string): string | null {
    if (!this.env.S3_PUBLIC_BASE_URL) return null;
    const base = this.env.S3_PUBLIC_BASE_URL.replace(/\/+$/, '');
    return `${base}/${objectKey}`;
  }

  async head(objectKey: string): Promise<ObjectMetadata | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return {
        contentLength: res.ContentLength ?? 0,
        contentType: res.ContentType ?? null,
        etag: res.ETag ?? null,
        lastModified: res.LastModified ?? null,
      };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw err;
    }
  }

  /** 读取对象前若干字节。用于校验文件真实类型(magic bytes),不把整个文件读入内存。 */
  async readRange(objectKey: string, bytes: number): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey, Range: `bytes=0-${bytes - 1}` }),
      );
      if (!res.Body) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as Readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw err;
    }
  }

  /** 以流的方式获取对象。批量下载打包时使用,避免把全部原图载入内存。 */
  async getStream(objectKey: string): Promise<Readable | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return (res.Body as Readable) ?? null;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async putBuffer(params: {
    objectKey: string;
    body: Buffer;
    contentType: string;
    cacheControl?: string;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.objectKey,
        Body: params.body,
        ContentType: params.contentType,
        ...(params.cacheControl ? { CacheControl: params.cacheControl } : {}),
      }),
    );
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  /** 批量删除(清理任务使用),单次上限 1000 由 S3 协议规定 */
  async deleteMany(objectKeys: string[]): Promise<{ deleted: number; errors: string[] }> {
    if (objectKeys.length === 0) return { deleted: 0, errors: [] };

    let deleted = 0;
    const errors: string[] = [];
    for (let i = 0; i < objectKeys.length; i += 1000) {
      const batch = objectKeys.slice(i, i + 1000);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      deleted += batch.length - (res.Errors?.length ?? 0);
      for (const e of res.Errors ?? []) {
        errors.push(`${e.Key}: ${e.Code}`);
      }
    }
    return { deleted, errors };
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const startedAt = Date.now();
    try {
      // HeadObject 一个不存在的键:能正常返回 NotFound 即说明连通且凭据有效
      await this.head(`__health__/${Date.now()}`);
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: (err as Error).message.slice(0, 200),
      };
    }
  }
}
