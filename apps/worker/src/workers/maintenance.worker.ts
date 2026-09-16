/**
 * 清理与维护 Worker。
 *
 * 全部清理任务遵守四条铁律:
 *  1. **删除前必须复查业务引用**。只看"上传时间超过 N 小时"就删,会把有效商品图、
 *     帖子插图、历史生成结果一起删掉。判据是 refCount **加上**真实的业务引用查询
 *     (Post/Product 的封面与图片数组、GenerationResult.assetId、GenerationTask.referenceAssetIds、
 *     User.avatarKey),两者取"只要有一个引用就不删"。
 *  2. **支持 dryRun**:只统计、只采样,不做任何删除。上线前先跑 dryRun 看样本。
 *  3. **写 CleanupRun 记录**:scanned / matched / affected / freedBytes / sample 全部落库,
 *     便于事后核对"到底删了什么"。
 *  4. **runKey 幂等**:同一 kind + runKey 只会真正执行一次(Redis 标记 + BullMQ jobId 双重保证),
 *     定时任务重复触发或人工重跑都不会重复计数、重复扣减用量。
 *
 * reconcile_unknown_tasks 是这里最敏感的一项:对 status=UNKNOWN 的任务
 * **用 providerTaskId 向上游核对结果**后再决定成功/失败,**绝不盲目重试**——
 * 那笔调用可能已经计费了。
 */
import { AssetStatus, PostStatus, ResultStatus, SessionScope, TaskStatus, type Prisma } from '@june/db';
import {
  QUEUE_NAMES,
  QUEUE_RETENTION,
  computeHotScore,
  type MaintenanceJob,
  type MaintenanceJobKind,
  type QueueName,
} from '@june/shared';
import { Worker, type Job } from 'bullmq';

import { loadEnv } from '../config/env';
import { openProviderApiKey } from '../lib/crypto';
import { failResults, persistImageResult, summarizeTask } from '../lib/generation-results';
import { createLogger } from '../lib/logger';
import { recordFailed, recordProcessed } from '../lib/metrics';
import { checkModelUsable } from '../lib/model-guard';
import { getPrisma } from '../lib/prisma';
import type { ProviderCredentials } from '../lib/provider-contract';
import { resolveImageProvider } from '../lib/provider-registry';
import { getQueue } from '../lib/queues';
import { cacheConnection, queueConnection } from '../lib/redis';
import { getS3 } from '../lib/s3';
import { withPeriodRunKey } from '../scheduler';

const log = createLogger('maintenance');

/** 采样明细最多记录多少条(便于人工确认,又不至于把 Json 撑爆) */
const SAMPLE_LIMIT = 50;

export interface CleanupOutcome {
  scanned: number;
  matched: number;
  affected: number;
  freedBytes: bigint;
  sample: unknown[];
  note?: string;
}

export function createMaintenanceWorker(): Worker<MaintenanceJob> {
  const env = loadEnv();
  return new Worker<MaintenanceJob>(QUEUE_NAMES.maintenance, (job) => handle(job), {
    connection: queueConnection(),
    prefix: env.QUEUE_PREFIX,
    concurrency: env.CONCURRENCY_MAINTENANCE,
    lockDuration: 30 * 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  });
}

async function handle(job: Job<MaintenanceJob>): Promise<void> {
  const startedAt = Date.now();
  // 定时产出的任务在这里补上按周期对齐的 runKey,使同一周期的重复触发被幂等跳过
  const { kind, dryRun, limit, triggeredBy, runKey } = withPeriodRunKey(job.data);

  // runKey 幂等:同一批次重跑直接跳过,不重复计数也不重复扣减用量
  if (runKey && !(await claimRunKey(kind, runKey))) {
    log.info(`维护任务 ${kind} 的 runKey=${runKey} 已执行过,跳过(幂等)`);
    return;
  }

  const prisma = getPrisma();
  const run = await prisma.cleanupRun.create({
    data: {
      kind,
      dryRun,
      status: 'running',
      triggeredBy: runKey ? `${triggeredBy}#${runKey}` : triggeredBy,
    },
  });

  try {
    const outcome = await dispatch(kind, { dryRun, limit: Math.max(1, Math.min(limit || 500, 10_000)) });
    await prisma.cleanupRun.update({
      where: { id: run.id },
      data: {
        status: 'succeeded',
        scanned: outcome.scanned,
        matched: outcome.matched,
        affected: outcome.affected,
        freedBytes: outcome.freedBytes,
        sample: outcome.sample.slice(0, SAMPLE_LIMIT) as unknown as Prisma.InputJsonValue,
        ...(outcome.note ? { errorMessage: outcome.note } : {}),
        finishedAt: new Date(),
      },
    });
    recordProcessed(job.queueName, Date.now() - startedAt);
    log.info(
      `维护任务 ${kind}${dryRun ? '(预览)' : ''} 完成:扫描 ${outcome.scanned}、` +
        `命中 ${outcome.matched}、处理 ${outcome.affected}、释放 ${outcome.freedBytes} 字节`,
    );
  } catch (err) {
    recordFailed(job.queueName);
    await prisma.cleanupRun
      .update({
        where: { id: run.id },
        data: {
          status: 'failed',
          errorMessage: (err as Error).message.slice(0, 1_000),
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
    // 失败时释放 runKey 标记,允许修好问题后重跑
    if (runKey) await releaseRunKey(kind, runKey);
    throw err;
  }
}

function dispatch(kind: MaintenanceJobKind, ctx: { dryRun: boolean; limit: number }): Promise<CleanupOutcome> {
  switch (kind) {
    case 'cleanup_expired_upload':
      return cleanupExpiredUpload(ctx);
    case 'cleanup_orphan_asset':
      return cleanupOrphanAsset(ctx);
    case 'purge_recycled_asset':
      return purgeRecycledAsset(ctx);
    case 'prune_queue_records':
      return pruneQueueRecords(ctx);
    case 'prune_sessions':
      return pruneSessions(ctx);
    case 'recompute_hot_scores':
      return recomputeHotScores(ctx);
    case 'reconcile_unknown_tasks':
      return reconcileUnknownTasks(ctx);
    case 'rewrap_secrets':
      // 重新包装密文需要 seal(加密),而 Worker 只持有 open(解密)能力,
      // 这是刻意的最小权限设计。密钥轮换请在 /admin 侧执行。
      return Promise.resolve({
        scanned: 0,
        matched: 0,
        affected: 0,
        freedBytes: 0n,
        sample: [],
        note: 'rewrap_secrets 不在 Worker 执行:Worker 只有解密能力,密钥轮换需由 API 侧带 seal 的服务完成',
      });
    default: {
      const exhaustive: never = kind;
      throw new Error(`未知的维护任务类型:${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 业务引用检查(所有删除动作的共同前置)
// ---------------------------------------------------------------------------

/**
 * 判断资产是否仍被业务引用。
 *
 * refCount 是"应该"的引用计数,但计数存在漂移可能(异常中断、旧数据),
 * 因此这里**再查一次真实引用**。任何一处引用存在就返回 true,宁可少删也不能误删。
 */
async function isReferenced(asset: {
  id: string;
  objectKey: string;
  ownerId: string;
  refCount: number;
}): Promise<{ referenced: boolean; reason: string | null }> {
  if (asset.refCount > 0) return { referenced: true, reason: `refCount=${asset.refCount}` };

  const prisma = getPrisma();

  const [postRef, productRef, resultRef, taskRef, avatarRef] = await Promise.all([
    prisma.post.findFirst({
      where: {
        deletedAt: null,
        status: { not: PostStatus.DELETED },
        OR: [{ coverAssetId: asset.id }, { imageAssetIds: { has: asset.id } }],
      },
      select: { id: true },
    }),
    prisma.product.findFirst({
      where: {
        deletedAt: null,
        OR: [{ coverAssetId: asset.id }, { imageAssetIds: { has: asset.id } }],
      },
      select: { id: true },
    }),
    prisma.generationResult.findFirst({ where: { assetId: asset.id }, select: { id: true } }),
    prisma.generationTask.findFirst({
      where: { referenceAssetIds: { has: asset.id } },
      select: { id: true },
    }),
    prisma.user.findFirst({
      where: { id: asset.ownerId, avatarKey: asset.objectKey },
      select: { id: true },
    }),
  ]);

  if (postRef) return { referenced: true, reason: `被帖子 ${postRef.id} 引用` };
  if (productRef) return { referenced: true, reason: `被商品 ${productRef.id} 引用` };
  if (resultRef) return { referenced: true, reason: `是生成结果 ${resultRef.id} 的图片` };
  if (taskRef) return { referenced: true, reason: `是任务 ${taskRef.id} 的参考图` };
  if (avatarRef) return { referenced: true, reason: '是用户头像' };
  return { referenced: false, reason: null };
}

/** 派生图对象也要一起删,否则原图删了缩略图还留在桶里 */
function derivativeKeysOf(derivatives: unknown): string[] {
  if (!derivatives || typeof derivatives !== 'object' || Array.isArray(derivatives)) return [];
  const keys: string[] = [];
  for (const value of Object.values(derivatives as Record<string, unknown>)) {
    if (value && typeof value === 'object' && typeof (value as { key?: unknown }).key === 'string') {
      keys.push((value as { key: string }).key);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// cleanup_expired_upload
// ---------------------------------------------------------------------------

/**
 * 清理"签发了直传凭证但一直没确认"的资产。
 * 这类资产 status=PENDING、从未计入 StorageUsage,但对象可能已经上传到桶里,
 * 不清就是纯粹的空间浪费。
 */
async function cleanupExpiredUpload(ctx: { dryRun: boolean; limit: number }): Promise<CleanupOutcome> {
  const env = loadEnv();
  const prisma = getPrisma();
  const s3 = getS3();
  const cutoff = new Date(Date.now() - env.ASSET_ORPHAN_GRACE_HOURS * 3_600_000);

  const candidates = await prisma.asset.findMany({
    where: { status: AssetStatus.PENDING, createdAt: { lt: cutoff } },
    take: ctx.limit,
    orderBy: { createdAt: 'asc' },
  });

  let matched = 0;
  let affected = 0;
  let freedBytes = 0n;
  const sample: unknown[] = [];

  for (const asset of candidates) {
    // 删除前再次检查 refCount 与业务引用:PENDING 也可能被抢先关联
    const ref = await isReferenced(asset);
    if (ref.referenced) {
      sample.push({ assetId: asset.id, action: 'skipped', reason: ref.reason });
      continue;
    }
    matched += 1;

    const head = await s3.head(asset.objectKey).catch(() => null);
    const bytes = BigInt(head?.contentLength ?? asset.byteSize ?? 0);
    sample.push({
      assetId: asset.id,
      objectKey: asset.objectKey,
      bytes: bytes.toString(),
      uploaded: head !== null,
    });
    if (ctx.dryRun) continue;

    if (head) {
      await s3.deleteQuietly(asset.objectKey);
      for (const key of derivativeKeysOf(asset.derivatives)) await s3.deleteQuietly(key);
      freedBytes += bytes;
    }
    // PENDING 从未计入 bytesUsed,因此这里不动 StorageUsage
    await prisma.asset.update({
      where: { id: asset.id },
      data: { status: AssetStatus.PURGED, purgedAt: new Date() },
    });
    affected += 1;
  }

  return { scanned: candidates.length, matched, affected, freedBytes, sample };
}

// ---------------------------------------------------------------------------
// cleanup_orphan_asset
// ---------------------------------------------------------------------------

/**
 * 标记孤儿资产:ACTIVE 且 refCount=0 且超过宽限期。
 *
 * **只标记 ORPHAN,不删除文件、不扣用量。** 这一步是可逆的:
 * 用户重新使用这张图时(assetsService 的去重路径)会把它恢复成 ACTIVE。
 * 真正的物理删除只发生在用户主动删除(RECYCLED)且回收期结束之后。
 */
async function cleanupOrphanAsset(ctx: { dryRun: boolean; limit: number }): Promise<CleanupOutcome> {
  const env = loadEnv();
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - env.ASSET_ORPHAN_GRACE_HOURS * 3_600_000);

  const candidates = await prisma.asset.findMany({
    where: {
      status: AssetStatus.ACTIVE,
      refCount: 0,
      // 用 confirmedAt 而不是 createdAt:确认时间才是"进入可用状态"的时间
      OR: [{ confirmedAt: { lt: cutoff } }, { confirmedAt: null, createdAt: { lt: cutoff } }],
    },
    take: ctx.limit,
    orderBy: { createdAt: 'asc' },
  });

  let matched = 0;
  let affected = 0;
  const sample: unknown[] = [];

  for (const asset of candidates) {
    const ref = await isReferenced(asset);
    if (ref.referenced) {
      // 真实引用存在但 refCount=0 → 计数漂移。记录下来供排查,绝不据此删除。
      sample.push({ assetId: asset.id, action: 'skipped', reason: ref.reason });
      continue;
    }
    matched += 1;
    sample.push({ assetId: asset.id, kind: asset.kind, bytes: asset.byteSize, action: 'mark_orphan' });
    if (ctx.dryRun) continue;

    await prisma.asset.update({ where: { id: asset.id }, data: { status: AssetStatus.ORPHAN } });
    affected += 1;
  }

  return { scanned: candidates.length, matched, affected, freedBytes: 0n, sample };
}

// ---------------------------------------------------------------------------
// purge_recycled_asset
// ---------------------------------------------------------------------------

/** 回收期已过的 RECYCLED 资产:删对象存储 + 置 PURGED + 扣 recycledBytes */
async function purgeRecycledAsset(ctx: { dryRun: boolean; limit: number }): Promise<CleanupOutcome> {
  const env = loadEnv();
  const prisma = getPrisma();
  const s3 = getS3();
  const cutoff = new Date(Date.now() - env.ASSET_RECYCLE_DAYS * 86_400_000);

  const candidates = await prisma.asset.findMany({
    where: { status: AssetStatus.RECYCLED, recycledAt: { lt: cutoff } },
    take: ctx.limit,
    orderBy: { recycledAt: 'asc' },
  });

  let matched = 0;
  let affected = 0;
  let freedBytes = 0n;
  const sample: unknown[] = [];

  for (const asset of candidates) {
    // 回收期内用户可能又把这张图用在别处,删除前必须再查一次
    const ref = await isReferenced(asset);
    if (ref.referenced) {
      sample.push({ assetId: asset.id, action: 'skipped', reason: ref.reason });
      continue;
    }
    matched += 1;
    sample.push({ assetId: asset.id, objectKey: asset.objectKey, bytes: asset.byteSize });
    if (ctx.dryRun) continue;

    const keys = [asset.objectKey, ...derivativeKeysOf(asset.derivatives)];
    const { errors } = await s3.deleteMany(keys);
    if (errors.length > 0) {
      // 对象删不掉就不要标记 PURGED,否则会变成"数据库说删了、桶里还占着空间"
      log.warn(`资产 ${asset.id} 的对象删除有失败项,保持 RECYCLED 待下次重试:${errors.join('; ')}`);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.asset.update({
        where: { id: asset.id },
        data: { status: AssetStatus.PURGED, purgedAt: new Date() },
      });
      // recycledBytes 在进入回收期时被加上,物理删除后减掉
      await tx.storageUsage.updateMany({
        where: { userId: asset.ownerId },
        data: { recycledBytes: { decrement: BigInt(asset.byteSize) } },
      });
    });
    freedBytes += BigInt(asset.byteSize);
    affected += 1;
  }

  return { scanned: candidates.length, matched, affected, freedBytes, sample };
}

// ---------------------------------------------------------------------------
// prune_queue_records / prune_sessions
// ---------------------------------------------------------------------------

/**
 * 清理 BullMQ 里的历史任务记录。
 * 权威任务状态在 PostgreSQL 的 GenerationTask,删掉队列记录不会丢业务数据。
 */
async function pruneQueueRecords(ctx: { dryRun: boolean; limit: number }): Promise<CleanupOutcome> {
  let affected = 0;
  let scanned = 0;
  const sample: unknown[] = [];

  for (const name of Object.values(QUEUE_NAMES) as QueueName[]) {
    const queue = getQueue(name);
    const counts = await queue.getJobCounts('completed', 'failed');
    scanned += (counts.completed ?? 0) + (counts.failed ?? 0);

    if (ctx.dryRun) {
      sample.push({ queue: name, completed: counts.completed ?? 0, failed: counts.failed ?? 0 });
      continue;
    }
    const completed = await queue.clean(QUEUE_RETENTION.completedAgeSeconds * 1000, ctx.limit, 'completed');
    const failed = await queue.clean(QUEUE_RETENTION.failedAgeSeconds * 1000, ctx.limit, 'failed');
    affected += completed.length + failed.length;
    sample.push({ queue: name, cleanedCompleted: completed.length, cleanedFailed: failed.length });
  }

  return { scanned, matched: scanned, affected, freedBytes: 0n, sample };
}

/** 过期会话、已撤销会话、过期重验令牌、已完成的历史导入作业记录 */
async function pruneSessions(ctx: { dryRun: boolean; limit: number }): Promise<CleanupOutcome> {
  const prisma = getPrisma();
  const now = new Date();
  const revokedCutoff = new Date(now.getTime() - 30 * 86_400_000);

  const sessionWhere = {
    OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: revokedCutoff } }],
  };
  const tokenWhere = { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: revokedCutoff } }] };

  const [sessionCount, tokenCount] = await Promise.all([
    prisma.session.count({ where: sessionWhere }),
    prisma.reauthToken.count({ where: tokenWhere }),
  ]);

  const sample: unknown[] = [
    { table: 'sessions', matched: sessionCount, scope: Object.values(SessionScope).join('/') },
    { table: 'reauth_tokens', matched: tokenCount },
  ];
  if (ctx.dryRun) {
    return {
      scanned: sessionCount + tokenCount,
      matched: sessionCount + tokenCount,
      affected: 0,
      freedBytes: 0n,
      sample,
    };
  }

  const sessions = await prisma.session.deleteMany({ where: sessionWhere });
  const tokens = await prisma.reauthToken.deleteMany({ where: tokenWhere });

  return {
    scanned: sessionCount + tokenCount,
    matched: sessionCount + tokenCount,
    affected: sessions.count + tokens.count,
    freedBytes: 0n,
    sample,
  };
}

// ---------------------------------------------------------------------------
// recompute_hot_scores
// ---------------------------------------------------------------------------

/**
 * 批量重算帖子热门分。口径完全交给 @june/shared 的 computeHotScore,
 * 前端"热门规则说明"与这里用同一个函数,保证展示与排序一致。
 * 置顶帖不参与热门排序,但仍然重算(取消置顶后立即可用)。
 */
async function recomputeHotScores(ctx: { dryRun: boolean; limit: number }): Promise<CleanupOutcome> {
  const prisma = getPrisma();
  const now = new Date();
  const batchSize = 500;

  let cursor: string | null = null;
  let scanned = 0;
  let affected = 0;
  const sample: unknown[] = [];

  for (;;) {
    const posts = await prisma.post.findMany({
      where: { status: PostStatus.PUBLISHED, deletedAt: null, publishedAt: { not: null } },
      select: {
        id: true,
        likeCount: true,
        commentCount: true,
        viewCount: true,
        publishedAt: true,
        hotScore: true,
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (posts.length === 0) break;
    scanned += posts.length;
    cursor = posts[posts.length - 1]!.id;

    const updates = posts
      .map((post) => ({
        id: post.id,
        hotScore: computeHotScore({
          likeCount: post.likeCount,
          commentCount: post.commentCount,
          viewCount: post.viewCount,
          publishedAt: post.publishedAt,
          now,
        }),
        previous: post.hotScore,
      }))
      // 只写变化超过千分之一的,避免每 5 分钟把整表 UPDATE 一遍
      .filter((u) => Math.abs(u.hotScore - u.previous) > u.previous * 0.001 + 1e-9);

    if (sample.length < SAMPLE_LIMIT) {
      sample.push(
        ...updates.slice(0, SAMPLE_LIMIT - sample.length).map((u) => ({
          postId: u.id,
          from: Number(u.previous.toFixed(6)),
          to: Number(u.hotScore.toFixed(6)),
        })),
      );
    }

    if (!ctx.dryRun && updates.length > 0) {
      // 分批事务:一批 500 条,避免长事务锁住整张 posts 表
      await prisma.$transaction(
        updates.map((u) =>
          prisma.post.update({ where: { id: u.id }, data: { hotScore: u.hotScore } }),
        ),
      );
      affected += updates.length;
    }
    if (posts.length < batchSize) break;
  }

  return { scanned, matched: scanned, affected, freedBytes: 0n, sample };
}

// ---------------------------------------------------------------------------
// reconcile_unknown_tasks
// ---------------------------------------------------------------------------

/**
 * 核对结果未知的任务。
 *
 * **绝不重新提交生成请求。** 只做两件事:
 *   1. 有 providerTaskId → 调用适配器的 poll 向上游查这笔任务的真实结果:
 *      - completed → 补录结果(转存图片),任务落 SUCCEEDED / PARTIAL;
 *      - 明确失败 → 任务落 FAILED;
 *      - 仍在处理 / 查不到 → 保持 UNKNOWN,把已尝试次数 +1 记在 attempt 上。
 *   2. 没有 providerTaskId(例如提交阶段连接就断了)→ 无从核对,保持 UNKNOWN 并累加尝试次数,
 *      留给人工在后台按供应商账单核对。
 */
async function reconcileUnknownTasks(ctx: { dryRun: boolean; limit: number }): Promise<CleanupOutcome> {
  const prisma = getPrisma();

  const tasks = await prisma.generationTask.findMany({
    where: { status: TaskStatus.UNKNOWN },
    include: { modelConfig: { include: { provider: true } }, results: true },
    take: ctx.limit,
    orderBy: { updatedAt: 'asc' },
  });

  let matched = 0;
  let affected = 0;
  const sample: unknown[] = [];

  for (const task of tasks) {
    matched += 1;
    const providerTaskId = task.providerTaskIds.at(-1) ?? null;

    if (!providerTaskId) {
      sample.push({ taskId: task.id, action: 'keep_unknown', reason: '没有 providerTaskId,无从核对' });
      if (!ctx.dryRun) await bumpReconcileAttempt(task.id, '没有上游任务号,无法自动核对,请按供应商账单人工确认');
      continue;
    }

    const guard = checkModelUsable(task.modelConfig);
    if (!guard.ok) {
      sample.push({ taskId: task.id, action: 'keep_unknown', reason: `模型/凭据不可用(${guard.errorCode})` });
      if (!ctx.dryRun) await bumpReconcileAttempt(task.id, '模型或凭据已不可用,无法自动核对');
      continue;
    }

    if (ctx.dryRun) {
      sample.push({ taskId: task.id, action: 'would_poll', providerTaskId });
      continue;
    }

    try {
      const apiKey = openProviderApiKey(guard.model.provider);
      if (!apiKey) throw new Error('供应商凭据缺失');
      const creds: ProviderCredentials = { apiKey, baseUrl: guard.model.provider.baseUrl };
      const adapter = resolveImageProvider(guard.model.providerKind);
      if (!adapter.poll) throw new Error('该供应商适配器不支持结果核对(没有 poll)');

      const outcome = await adapter.poll(providerTaskId, creds, { timeoutMs: 60_000 });

      if (outcome.kind === 'completed') {
        // 补录:上游确实出图了(而且已经计费),必须把图收下来交付用户
        const pendingSeqs = task.results.filter((r) => r.status === ResultStatus.PENDING).map((r) => r.seq).sort((a, b) => a - b);
        for (let i = 0; i < pendingSeqs.length; i += 1) {
          const seq = pendingSeqs[i]!;
          const image = outcome.images[i];
          if (!image) {
            await failResults(task.id, [seq], 'UPSTREAM_ERROR', '核对时上游返回的图片数量不足');
            continue;
          }
          await persistImageResult({
            taskId: task.id,
            userId: task.userId,
            seq,
            image,
            providerTaskId,
          });
        }
        await summarizeTask({
          taskId: task.id,
          userId: task.userId,
          requestedCount: task.requestedCount,
        });
        affected += 1;
        sample.push({ taskId: task.id, action: 'recovered', images: outcome.images.length });
        continue;
      }

      if (outcome.kind === 'pending') {
        await bumpReconcileAttempt(task.id, '上游仍在处理中,保持结果待确认');
        sample.push({ taskId: task.id, action: 'still_pending' });
        continue;
      }

      // 上游明确说这笔任务失败了:可以放心落 FAILED
      const pendingSeqs = task.results.filter((r) => r.status === ResultStatus.PENDING).map((r) => r.seq);
      await failResults(task.id, pendingSeqs, outcome.errorCode, outcome.message);
      await prisma.generationTask.update({
        where: { id: task.id },
        data: {
          status: task.succeededCount > 0 ? TaskStatus.PARTIAL : TaskStatus.FAILED,
          errorCode: outcome.errorCode,
          errorMessage: `核对结果:${outcome.message}`.slice(0, 2_000),
          retryable: outcome.retryable,
          failedCount: pendingSeqs.length + task.failedCount,
          finishedAt: new Date(),
        },
      });
      affected += 1;
      sample.push({ taskId: task.id, action: 'confirmed_failed', errorCode: outcome.errorCode });
    } catch (err) {
      // 核对本身失败不改变任务状态:保持 UNKNOWN 比猜错更安全
      log.warn(`核对任务 ${task.id} 失败:${(err as Error).message}`);
      await bumpReconcileAttempt(task.id, `核对失败:${(err as Error).message}`);
      sample.push({ taskId: task.id, action: 'keep_unknown', reason: (err as Error).message.slice(0, 200) });
    }
  }

  return { scanned: tasks.length, matched, affected, freedBytes: 0n, sample };
}

/** 记录"已尝试核对 N 次",便于运维判断是否需要人工介入 */
async function bumpReconcileAttempt(taskId: string, reason: string): Promise<void> {
  const prisma = getPrisma();
  const task = await prisma.generationTask.findUnique({
    where: { id: taskId },
    select: { attempt: true },
  });
  const nextAttempt = (task?.attempt ?? 0) + 1;
  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      attempt: nextAttempt,
      errorMessage: `已核对 ${nextAttempt} 次仍未确认:${reason}`.slice(0, 2_000),
      // 结果未知期间永远不可自动重试
      retryable: false,
    },
  });
}

// ---------------------------------------------------------------------------
// runKey 幂等
// ---------------------------------------------------------------------------

const RUN_KEY_TTL_SECONDS = 7 * 86_400;

async function claimRunKey(kind: string, runKey: string): Promise<boolean> {
  try {
    const ok = await cacheConnection().set(
      `maint:runkey:${kind}:${runKey}`,
      Date.now(),
      'EX',
      RUN_KEY_TTL_SECONDS,
      'NX',
    );
    return ok === 'OK';
  } catch {
    // Redis 不可用时不阻塞维护任务(CleanupRun 记录仍能看出重复执行)
    return true;
  }
}

async function releaseRunKey(kind: string, runKey: string): Promise<void> {
  try {
    await cacheConnection().del(`maint:runkey:${kind}:${runKey}`);
  } catch {
    // 键自带 TTL,清理失败无副作用
  }
}
