/**
 * 对象存储访问(S3 兼容:AWS S3 / 阿里云 OSS / 腾讯云 COS / MinIO)。
 *
 * 写法与 apps/api/src/modules/storage/s3.service.ts 一致,只是去掉 Nest 装饰器,
 * 改成普通类 + 进程内单例——Worker 不使用依赖注入容器。
 *
 * 关键约定:
 *  - 图片二进制永远不经过数据库,数据库只存对象键与元信息;
 *  - 供应商返回的临时链接**只做溯源**,结果图必须先转存到本平台对象存储再交付用户。
 */
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

import { loadEnv } from '../config/env';
import { createLogger } from './logger';

const log = createLogger('s3');

export interface ObjectMetadata {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
}

export class WorkerS3 {
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
      maxAttempts: 3,
      // MinIO / 部分兼容实现不接受 SDK 默认的柔性校验和头(会报 Custom Id cannot contain :)
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
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

  /** 以流的方式获取对象。CSV 导入按行处理时使用,避免把整个文件读进内存。 */
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

  /** 整体读入内存。仅用于需要 sharp 处理的单张图片,调用方负责限制体积。 */
  async getBuffer(objectKey: string): Promise<Buffer | null> {
    const stream = await this.getStream(objectKey);
    if (!stream) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
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

  /** 尽力删除:清理失败只告警,不让整批清理中断 */
  async deleteQuietly(objectKey: string): Promise<boolean> {
    try {
      await this.delete(objectKey);
      return true;
    } catch (err) {
      log.warn(`删除对象失败 ${objectKey}: ${(err as Error).message}`);
      return false;
    }
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
      for (const e of res.Errors ?? []) errors.push(`${e.Key}: ${e.Code}`);
    }
    return { deleted, errors };
  }

  /** 私有资源的短时下载 URL。Worker 一般不需要,保留给核对/排查场景。 */
  async presignDownload(objectKey: string, expiresIn?: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }), {
      expiresIn: expiresIn ?? this.env.S3_SIGNED_URL_TTL_SECONDS,
    });
  }

  async ping(): Promise<boolean> {
    try {
      // HeadObject 一个不存在的键:能正常返回 NotFound 即说明连通且凭据有效
      await this.head(`__health__/${Date.now()}`);
      return true;
    } catch {
      return false;
    }
  }
}

let instance: WorkerS3 | null = null;

export function getS3(): WorkerS3 {
  if (!instance) instance = new WorkerS3();
  return instance;
}
