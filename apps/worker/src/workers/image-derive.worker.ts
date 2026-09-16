/**
 * 缩略图 / 预览图派生 Worker。
 *
 * 内存取舍(目标机型 4 核 8G):
 *   sharp 底层是 libvips,单张大图解码 + 缩放的峰值内存可以达到原图像素数的数倍。
 *   libvips 默认会开 CPU 核数个线程,多个并发任务叠加很容易把 8G 打满并触发 OOM,
 *   而 OOM 会带走整个 Worker 进程(连正在跑的生图任务一起),代价远大于"派生慢一点"。
 *   因此:
 *     - `sharp.concurrency(1)`:每个 sharp 操作只用一个 libvips 线程;
 *     - BullMQ 并发用 CONCURRENCY_IMAGE_PROCESS(建议 1~2),与 CPU 核数解耦;
 *     - 关闭 sharp 的像素缓存,避免长时间运行的进程把缓存堆到几百 MB。
 *
 * 图像质量取舍见 lib/derivatives.ts 的 DerivativePlan.sharpen 注释。
 */
import { AssetKind, AssetStatus } from '@june/db';
import { QUEUE_NAMES, type ImageDeriveJob } from '@june/shared';
import { Worker, type Job } from 'bullmq';
import sharp from 'sharp';

import { loadEnv } from '../config/env';
import {
  derivativeObjectKey,
  planAllDerivatives,
  type DerivativeMap,
  type DerivativePlan,
} from '../lib/derivatives';
import { createLogger } from '../lib/logger';
import { recordFailed, recordProcessed } from '../lib/metrics';
import { getPrisma } from '../lib/prisma';
import { queueConnection } from '../lib/redis';
import { getS3 } from '../lib/s3';

const log = createLogger('image-derive');

// 全局一次性设置,必须在任何 sharp 操作之前
sharp.concurrency(1);
sharp.cache({ memory: 64, files: 0, items: 100 });

export function createImageDeriveWorker(): Worker<ImageDeriveJob> {
  const env = loadEnv();
  return new Worker<ImageDeriveJob>(QUEUE_NAMES.imageDerive, (job) => handle(job), {
    connection: queueConnection(),
    prefix: env.QUEUE_PREFIX,
    // sharp 吃内存,并发刻意压得很低
    concurrency: env.CONCURRENCY_IMAGE_PROCESS,
    lockDuration: 120_000,
    stalledInterval: 30_000,
    // 派生图是纯计算、无外部计费,重投是安全的
    maxStalledCount: 2,
  });
}

async function handle(job: Job<ImageDeriveJob>): Promise<void> {
  const startedAt = Date.now();
  const prisma = getPrisma();
  const s3 = getS3();
  const { assetId, ownerId } = job.data;

  const asset = await prisma.asset.findFirst({ where: { id: assetId, ownerId } });
  if (!asset) {
    log.warn(`资产 ${assetId} 不存在或归属不符,跳过派生`);
    return;
  }
  if (asset.kind === AssetKind.IMPORT_FILE) {
    await prisma.asset.update({ where: { id: asset.id }, data: { derivativeStatus: 'skipped' } });
    return;
  }
  if (asset.status !== AssetStatus.ACTIVE) {
    log.info(`资产 ${assetId} 当前状态 ${asset.status},跳过派生`);
    return;
  }
  // 幂等:已经生成过就不重复烧 CPU
  if (asset.derivativeStatus === 'ready') {
    log.debug(`资产 ${assetId} 已有派生图,跳过`);
    return;
  }

  try {
    const original = await s3.getBuffer(asset.objectKey);
    if (!original) {
      await prisma.asset.update({ where: { id: asset.id }, data: { derivativeStatus: 'failed' } });
      log.warn(`资产 ${assetId} 的原图对象不存在,派生标记为 failed`);
      return;
    }

    // failOn: 'none' —— 上游/用户的图可能带轻微损坏,能解出来就别整张放弃
    const metadata = await sharp(original, { failOn: 'none' }).metadata();
    const sourceWidth = metadata.width ?? 0;
    const sourceHeight = metadata.height ?? 0;
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      await prisma.asset.update({ where: { id: asset.id }, data: { derivativeStatus: 'failed' } });
      log.warn(`资产 ${assetId} 无法读取尺寸,派生标记为 failed`);
      return;
    }

    // hasAlpha 是"是否保留透明背景"的唯一判据。
    // 有 alpha 的图一旦落到 JPEG,透明区会被填成纯色,抠好的商品图就废了。
    const hasAlpha = metadata.hasAlpha === true;

    const derivatives: DerivativeMap = {};
    for (const plan of planAllDerivatives({ sourceWidth, sourceHeight, hasAlpha })) {
      const encoded = await encodeDerivative(original, plan);
      const key = derivativeObjectKey(asset.objectKey, plan.name, encoded.format);
      await s3.putBuffer({
        objectKey: key,
        body: encoded.body,
        contentType: encoded.mimeType,
        // 派生图内容由原图 + 规格唯一确定,可以放心长缓存
        cacheControl: 'public, max-age=31536000, immutable',
      });
      derivatives[plan.name] = {
        key,
        width: encoded.width,
        height: encoded.height,
        bytes: encoded.body.byteLength,
        mimeType: encoded.mimeType,
      };
      log.debug(
        `资产 ${assetId} 派生 ${plan.name}: ${encoded.width}x${encoded.height} ` +
          `${encoded.format}${plan.keepAlpha ? '(含 alpha)' : ''} ${encoded.body.byteLength}B`,
      );
    }

    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        derivatives: derivatives as unknown as object,
        derivativeStatus: 'ready',
        // 顺手补齐原图真实宽高(上传确认阶段没有解码图片,这里是第一次拿到准确值)
        width: sourceWidth,
        height: sourceHeight,
      },
    });

    recordProcessed(job.queueName, Date.now() - startedAt);
    log.info(
      `资产 ${assetId} 派生完成:原图 ${sourceWidth}x${sourceHeight}` +
        `${hasAlpha ? ' 含透明通道' : ''},产出 ${Object.keys(derivatives).join('/')}`,
    );
  } catch (err) {
    recordFailed(job.queueName);
    // 只有重试全部用尽后才写 failed,否则中间态会让前端提前显示"缩略图失败"
    if ((job.attemptsMade ?? 0) + 1 >= (job.opts.attempts ?? 1)) {
      await prisma.asset
        .update({ where: { id: assetId }, data: { derivativeStatus: 'failed' } })
        .catch(() => undefined);
    }
    throw err;
  }
}

interface EncodedDerivative {
  body: Buffer;
  width: number;
  height: number;
  format: DerivativePlan['format'] | DerivativePlan['fallbackFormat'];
  mimeType: string;
}

/**
 * 按计划编码单张派生图。
 *
 * 三条不可妥协的参数:
 *   - `fit: 'inside'`:保持比例、不裁切;
 *   - `withoutEnlargement: true`:小图不放大(放大只会变糊并浪费空间);
 *   - 有 alpha 时输出格式必须支持 alpha(WebP 优先,退路 PNG),绝不落 JPEG。
 */
async function encodeDerivative(original: Buffer, plan: DerivativePlan): Promise<EncodedDerivative> {
  const build = (format: EncodedDerivative['format']) => {
    let pipeline = sharp(original, { failOn: 'none' })
      // 动图(GIF / 动态 WebP)默认只取第一帧:派生图用于列表与详情预览,
      // 保留动画会让文件体积失控,原图仍然完整保存,需要动图时读原图。
      .rotate() // 按 EXIF 方向摆正,避免手机拍的图缩略后躺倒
      .resize({
        width: plan.width,
        height: plan.height,
        fit: 'inside',
        withoutEnlargement: true,
      });

    if (plan.sharpen) {
      // 极轻锐化:救回缩放后商品文字的可读性,又不至于在纯色边缘产生描边
      pipeline = pipeline.sharpen({ sigma: 0.5 });
    }

    if (format === 'webp') {
      return pipeline.webp({
        quality: plan.quality,
        // alphaQuality 拉满,避免半透明边缘出现色带
        ...(plan.keepAlpha ? { alphaQuality: 100 } : {}),
        effort: 4,
      });
    }
    if (format === 'png') {
      return pipeline.png({ compressionLevel: 9, palette: true });
    }
    // 走到 JPEG 时一定是无 alpha 的图(见 planDerivative 的 fallbackFormat)
    return pipeline.jpeg({ quality: plan.quality, mozjpeg: true, chromaSubsampling: '4:2:0' });
  };

  try {
    const out = await build(plan.format).toBuffer({ resolveWithObject: true });
    return {
      body: out.data,
      width: out.info.width,
      height: out.info.height,
      format: plan.format,
      mimeType: `image/${plan.format}`,
    };
  } catch (err) {
    log.warn(`WebP 编码失败,回退到 ${plan.fallbackFormat}:${(err as Error).message}`);
    const out = await build(plan.fallbackFormat).toBuffer({ resolveWithObject: true });
    return {
      body: out.data,
      width: out.info.width,
      height: out.info.height,
      format: plan.fallbackFormat,
      mimeType: `image/${plan.fallbackFormat}`,
    };
  }
}
