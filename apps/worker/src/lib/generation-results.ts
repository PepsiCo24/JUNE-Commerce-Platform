/**
 * 生成结果的落库助手。
 *
 * 抽到 lib 是因为两处都要用同一套语义:
 *   - image-generation.worker:正常出图后转存;
 *   - maintenance 的 reconcile_unknown_tasks:核对 UNKNOWN 任务时补录结果。
 * 两边共用同一份实现,避免"核对补录"与"正常落库"行为不一致。
 */
import { ResultStatus, TaskStatus } from '@june/db';
import { ERROR_CODES } from '@june/shared';

import { loadEnv } from '../config/env';
import {
  QuotaExceededError,
  ResultTooLargeError,
  decodeBase64Image,
  downloadImage,
  storeGeneratedImage,
} from './asset-store';
import { createLogger } from './logger';
import { getPrisma } from './prisma';
import type { GeneratedImage } from './provider-contract';
import { TaskReporter } from './task-state';

const log = createLogger('generation-results');

export async function failResults(
  taskId: string,
  seqs: number[],
  errorCode: string,
  errorMessage: string,
  providerRefUrl: string | null = null,
): Promise<void> {
  if (seqs.length === 0) return;
  await getPrisma().generationResult.updateMany({
    where: { taskId, seq: { in: seqs }, status: { not: ResultStatus.SUCCEEDED } },
    data: {
      status: ResultStatus.FAILED,
      errorCode: errorCode.slice(0, 80),
      errorMessage: errorMessage.slice(0, 2_000),
      ...(providerRefUrl ? { providerRefUrl: providerRefUrl.slice(0, 1_000) } : {}),
      finishedAt: new Date(),
    },
  });
}

export interface ResultCounts {
  succeeded: number;
  failed: number;
  pending: number;
}

export async function countResults(taskId: string): Promise<ResultCounts> {
  const grouped = await getPrisma().generationResult.groupBy({
    by: ['status'],
    where: { taskId },
    _count: { _all: true },
  });
  const get = (status: ResultStatus): number =>
    grouped.find((g) => g.status === status)?._count._all ?? 0;
  return {
    succeeded: get(ResultStatus.SUCCEEDED),
    failed: get(ResultStatus.FAILED),
    pending: get(ResultStatus.PENDING),
  };
}

/**
 * 转存一张生成图并写入对应的 GenerationResult。
 *
 * 失败(超配额、超大、转存异常)时把该结果标记 FAILED 并写明原因,
 * **绝不静默丢弃**——用户必须知道"这张图为什么没有出来"。
 */
export async function persistImageResult(params: {
  taskId: string;
  userId: string;
  seq: number;
  image: GeneratedImage;
  providerTaskId: string | null;
}): Promise<boolean> {
  const env = loadEnv();
  const prisma = getPrisma();
  const { taskId, userId, seq, image } = params;

  try {
    let body: Buffer;
    if (image.base64) {
      body = decodeBase64Image(image.base64);
    } else if (image.url) {
      body = await downloadImage(image.url, env.UPLOAD_MAX_BYTES);
    } else {
      throw new Error('上游既没有返回图片链接也没有返回 base64');
    }

    const stored = await storeGeneratedImage({
      ownerId: userId,
      body,
      declaredMimeType: image.mimeType,
      originalName: `generated-${taskId}-${seq}`,
    });

    await prisma.generationResult.upsert({
      where: { taskId_seq: { taskId, seq } },
      create: {
        taskId,
        seq,
        status: ResultStatus.SUCCEEDED,
        assetId: stored.asset.id,
        providerRefUrl: image.url?.slice(0, 1_000) ?? null,
        providerTaskId: params.providerTaskId?.slice(0, 200) ?? null,
        finishedAt: new Date(),
      },
      update: {
        status: ResultStatus.SUCCEEDED,
        assetId: stored.asset.id,
        // 供应商临时链接只做溯源,不作为长期访问入口
        providerRefUrl: image.url?.slice(0, 1_000) ?? null,
        providerTaskId: params.providerTaskId?.slice(0, 200) ?? null,
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date(),
      },
    });
    return true;
  } catch (err) {
    const errorCode =
      err instanceof QuotaExceededError
        ? ERROR_CODES.QUOTA_EXCEEDED
        : err instanceof ResultTooLargeError
          ? ERROR_CODES.FILE_TOO_LARGE
          : ERROR_CODES.INTERNAL_ERROR;
    log.error(`任务 ${taskId} 第 ${seq} 张结果转存失败(${errorCode})`, err);
    await failResults(taskId, [seq], errorCode, (err as Error).message.slice(0, 500), image.url ?? null);
    return false;
  }
}

/** 全成功 SUCCEEDED / 部分成功 PARTIAL / 全失败 FAILED */
export function decideTaskStatus(counts: ResultCounts): TaskStatus {
  if (counts.failed === 0 && counts.pending === 0) return TaskStatus.SUCCEEDED;
  if (counts.succeeded > 0) return TaskStatus.PARTIAL;
  return TaskStatus.FAILED;
}

export async function summarizeTask(params: {
  taskId: string;
  userId: string;
  requestedCount: number;
  queueWaitMs?: number | null;
  upstreamDurationMs?: number | null;
  providerCallCount?: number;
  providerTaskIds?: string[];
}): Promise<{ status: TaskStatus; counts: ResultCounts }> {
  const counts = await countResults(params.taskId);
  const status = decideTaskStatus(counts);

  const reporter = new TaskReporter({
    taskId: params.taskId,
    userId: params.userId,
    requestedCount: params.requestedCount,
    succeededCount: counts.succeeded,
    failedCount: counts.failed,
    status,
    stage: 'checking',
    progressPercent: null,
  });
  await reporter.finish({
    status,
    stage: 'done',
    succeededCount: counts.succeeded,
    failedCount: counts.failed,
    ...(status === TaskStatus.SUCCEEDED
      ? { errorCode: null, errorMessage: null, retryable: false }
      : { retryable: status === TaskStatus.PARTIAL }),
    ...(params.upstreamDurationMs !== undefined ? { upstreamDurationMs: params.upstreamDurationMs } : {}),
    ...(params.queueWaitMs !== undefined ? { queueWaitMs: params.queueWaitMs } : {}),
    ...(params.providerCallCount !== undefined ? { providerCallCount: params.providerCallCount } : {}),
    ...(params.providerTaskIds !== undefined ? { providerTaskIds: params.providerTaskIds } : {}),
  });

  return { status, counts };
}
