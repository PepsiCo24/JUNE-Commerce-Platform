/**
 * 生图 Worker(整个 Worker 里最关键的一段)。
 *
 * 处理顺序刻意固定,每一步都对应一条"不能出错"的约束:
 *
 *   1. 回源数据库复核模型/供应商是否已停用或凭据被清除 → 停用则直接失败,**不调用上游**。
 *   2. 幂等:已经 SUCCEEDED 的 seq 直接跳过,失败项重试不会重复生成、不会重复计费。
 *   3. 取闸门:全局 → 每用户 → 供应商并发 → 供应商频率。取不到就延迟重排让出槽位(公平调度)。
 *   4. 解密供应商 API Key(与 API 侧 seal 完全同构的 open)。
 *   5. 按 countUpstreamCalls 拆调用,逐次提交/轮询;**每次调用单独计入供应商频率与 providerCallCount**。
 *   6. 结果立刻转存到本平台对象存储(供应商临时链接只做溯源)。
 *   7. 错误分类见 lib/errors.ts:429 退避重排 / 已提交后超时置 UNKNOWN 且绝不自动重试 /
 *      4xx 不可重试 / 5xx 可重试。
 *   8. finally 里一次性归还全部闸门。
 *
 * BullMQ 配置上的两个关键点:
 *   - `concurrency` 只是本进程的取件上限,真正的全局上限靠 Redis 闸门(可能有多个 Worker 进程);
 *   - `maxStalledCount: 0`:任务被判定 stalled 时**直接失败,不重新投递**。
 *     重新投递意味着可能第二次调用付费接口,而数据库里残留的 RUNNING 会由
 *     reclaimStaleRunningTasks 转成 UNKNOWN 走核对流程,这才是安全的恢复路径。
 */
import { AssetStatus, ResultStatus, TaskStatus } from '@june/db';
import {
  ERROR_CODES,
  QUEUE_NAMES,
  countUpstreamCalls,
  sleep,
  type ImageGenerationJob,
  type ModelLimits,
} from '@june/shared';
import { Worker, type Job } from 'bullmq';

import { loadEnv } from '../config/env';
import { GateSession } from '../lib/concurrency';
import { openProviderApiKey } from '../lib/crypto';
import { clearDeferCount, deferJob } from '../lib/defer';
import { classifyUpstreamFailure, toProviderFailure } from '../lib/errors';
import {
  countResults,
  failResults,
  persistImageResult,
  summarizeTask,
} from '../lib/generation-results';
import { createLogger } from '../lib/logger';
import { recordFailed, recordProcessed } from '../lib/metrics';
import { checkModelUsable } from '../lib/model-guard';
import { getPrisma } from '../lib/prisma';
import type {
  ImageCompleted,
  ImageGenerationOutcome,
  ImageGenerationRequest,
  ImageProvider,
  PollOutcome,
  ProviderCredentials,
  ProviderFailure,
  ReferenceImage,
} from '../lib/provider-contract';
import { resolveImageProvider } from '../lib/provider-registry';
import { queueConnection } from '../lib/redis';
import { getS3 } from '../lib/s3';
import { TaskReporter } from '../lib/task-state';

const log = createLogger('image-generation');

interface ImageInput {
  prompt?: string;
  negativePrompt?: string | null;
  size?: string | null;
  aspectRatio?: string | null;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
}

export function createImageGenerationWorker(): Worker<ImageGenerationJob> {
  const env = loadEnv();
  return new Worker<ImageGenerationJob>(
    QUEUE_NAMES.imageGeneration,
    (job, token) => handle(job, token),
    {
      connection: queueConnection(),
      prefix: env.QUEUE_PREFIX,
      // 进程内取件上限。全局上限由 Redis 闸门保证,因此这里等于全局额度是安全的
      concurrency: env.CONCURRENCY_IMAGE_GLOBAL,
      // 锁要盖住最长任务时长 + 余量,否则长任务会被误判 stalled
      lockDuration: env.TASK_IMAGE_TIMEOUT_MS + 60_000,
      stalledInterval: 30_000,
      // 绝不自动重投:重投等于可能第二次调用付费接口
      maxStalledCount: 0,
    },
  );
}

async function handle(job: Job<ImageGenerationJob>, token?: string): Promise<void> {
  const env = loadEnv();
  const prisma = getPrisma();
  const { taskId, userId, seqs } = job.data;
  const jobStartedAt = Date.now();
  const held = new GateSession();

  try {
    const task = await prisma.generationTask.findUnique({
      where: { id: taskId },
      include: { modelConfig: { include: { provider: true } }, results: true },
    });

    if (!task) {
      log.warn(`任务 ${taskId} 不存在(可能已被删除),跳过`);
      return;
    }
    if (task.userId !== userId) {
      // 载荷与数据库不一致:宁可不处理,也不能拿别人的任务去调用上游
      log.error(`任务 ${taskId} 的归属与队列载荷不一致,已拒绝处理`);
      return;
    }
    if (task.status === TaskStatus.CANCELED) {
      log.info(`任务 ${taskId} 已取消,跳过`);
      return;
    }
    if (task.status === TaskStatus.UNKNOWN) {
      // 结果未知的任务只能由 reconcile_unknown_tasks 核对后处理,不允许在这里重跑
      log.warn(`任务 ${taskId} 处于 UNKNOWN,等待核对,拒绝重跑以免重复计费`);
      return;
    }

    const bySeq = new Map(task.results.map((r) => [r.seq, r]));
    const targetSeqs = (seqs.length > 0 ? seqs : task.results.map((r) => r.seq)).slice().sort((a, b) => a - b);

    // ---- 幂等:已成功的 seq 不重做 ----
    const pendingSeqs = targetSeqs.filter((seq) => bySeq.get(seq)?.status !== ResultStatus.SUCCEEDED);
    if (pendingSeqs.length === 0) {
      log.info(`任务 ${taskId} 的目标序号已全部成功,跳过上游调用`);
      await summarizeTask({
        taskId,
        userId,
        requestedCount: task.requestedCount,
        queueWaitMs: task.queueWaitMs,
      });
      return;
    }

    const reporter = new TaskReporter({
      taskId,
      userId,
      requestedCount: task.requestedCount,
      succeededCount: task.succeededCount,
      failedCount: task.failedCount,
      status: task.status,
      stage: 'queued',
      // 上游没给真实百分比时保持 null,前端只展示阶段文案
      progressPercent: null,
    });

    // ---- 1. 模型停用复核(回源数据库,不看缓存)----
    const guard = checkModelUsable(task.modelConfig);
    if (!guard.ok) {
      log.warn(`任务 ${taskId} 的模型不可用(${guard.errorCode}),未调用上游即终止`);
      await failResults(taskId, pendingSeqs, guard.errorCode, guard.message);
      await reporter.finish({
        status: TaskStatus.FAILED,
        errorCode: guard.errorCode,
        errorMessage: guard.message,
        retryable: false,
        queueWaitMs: Date.now() - task.createdAt.getTime(),
      });
      recordFailed(job.queueName);
      return;
    }
    const model = guard.model;

    // ---- 2. 闸门:全局 → 每用户 → 供应商并发 ----
    if (!(await held.acquireGlobal('image', env.CONCURRENCY_IMAGE_GLOBAL))) {
      throw await deferJob(job, token, '全局生图并发已满');
    }
    if (!(await held.acquireUser(userId, env.CONCURRENCY_IMAGE_PER_USER_RUNNING))) {
      throw await deferJob(job, token, '该用户已有生图任务在运行');
    }
    if (!(await held.acquireProviderConcurrency(model.provider.slug, model.provider.maxConcurrency))) {
      throw await deferJob(job, token, `供应商 ${model.provider.slug} 并发已满`);
    }

    // ---- 标记开始 ----
    const queueWaitMs = Date.now() - task.createdAt.getTime();
    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.RUNNING,
        stage: 'submitting',
        startedAt: task.startedAt ?? new Date(),
        queueWaitMs,
        attempt: job.data.attempt,
        errorCode: null,
        errorMessage: null,
        retryable: false,
      },
    });
    await reporter.setStage('submitting');

    // ---- 3. 解密 API Key ----
    let apiKey: string | null = null;
    try {
      apiKey = openProviderApiKey(model.provider);
    } catch (err) {
      log.error(`任务 ${taskId} 解密供应商凭据失败`, err);
    }
    if (!apiKey) {
      const message = '供应商凭据无法解密,请在后台重新录入 API Key(任务未产生任何上游调用)';
      await failResults(taskId, pendingSeqs, ERROR_CODES.MODEL_CREDENTIAL_MISSING, message);
      await reporter.finish({
        status: TaskStatus.FAILED,
        errorCode: ERROR_CODES.MODEL_CREDENTIAL_MISSING,
        errorMessage: message,
        retryable: false,
        queueWaitMs,
      });
      recordFailed(job.queueName);
      return;
    }
    const creds: ProviderCredentials = { apiKey, baseUrl: model.provider.baseUrl };

    // ---- 适配器 ----
    let adapter: ImageProvider;
    try {
      adapter = resolveImageProvider(model.providerKind);
    } catch (err) {
      const message = `供应商适配器不可用:${(err as Error).message}`;
      await failResults(taskId, pendingSeqs, ERROR_CODES.MODEL_NOT_AVAILABLE, message);
      await reporter.finish({
        status: TaskStatus.FAILED,
        errorCode: ERROR_CODES.MODEL_NOT_AVAILABLE,
        errorMessage: message,
        retryable: true,
        queueWaitMs,
      });
      recordFailed(job.queueName);
      return;
    }

    const input = (task.input ?? {}) as ImageInput;
    const referenceImages = await loadReferenceImages(userId, task.referenceAssetIds, model.limits);

    // ---- 4. 按模型能力拆分上游调用 ----
    const perCall = Math.max(1, Math.min(model.limits.maxOutputsPerCall, model.limits.maxOutputs));
    const chunks = chunkSeqs(pendingSeqs, perCall);
    const expectedCalls = countUpstreamCalls(pendingSeqs.length, model.limits);
    if (chunks.length !== expectedCalls) {
      // 只是自检:两者应当恒等。不一致说明 limits 语义被改动,记录以便排查
      log.warn(`任务 ${taskId} 调用次数自检不一致:分片 ${chunks.length} vs 预期 ${expectedCalls}`);
    }

    let providerCallCount = task.providerCallCount;
    const providerTaskIds = [...task.providerTaskIds];
    let upstreamDurationMs = task.upstreamDurationMs ?? 0;
    const deadline = jobStartedAt + env.TASK_IMAGE_TIMEOUT_MS;

    for (const chunk of chunks) {
      // 任务整体超时
      if (Date.now() >= deadline) {
        const disposition = classifyUpstreamFailure({
          failure: {
            errorCode: ERROR_CODES.UPSTREAM_TIMEOUT,
            message: `任务超过 ${env.TASK_IMAGE_TIMEOUT_MS}ms 上限`,
            retryable: false,
          },
          // 已经发生过上游调用 → 可能已计费 → 走 UNKNOWN;一次都没调用过才判 TIMEOUT
          phase: providerCallCount > 0 ? 'poll_exhausted' : 'never_submitted_timeout',
          attempt: job.data.attempt,
          providerTaskId: providerTaskIds.at(-1) ?? null,
        });
        await applyTerminalDisposition({
          reporter,
          taskId,
          seqs: chunk,
          disposition,
          providerCallCount,
          providerTaskIds,
          upstreamDurationMs,
          queueWaitMs,
        });
        recordFailed(job.queueName);
        return;
      }

      // ---- 供应商频率限制:每一次上游调用都单独计入 ----
      const rate = await held.acquireProviderRate(model.provider.slug, model.provider.rateLimitPerMinute);
      if (!rate.ok) {
        throw await deferJob(job, token, `供应商 ${model.provider.slug} 触发频率限制`, rate.waitMs);
      }

      const request: ImageGenerationRequest = {
        prompt: input.prompt ?? '',
        ...(input.negativePrompt && model.limits.supportsNegativePrompt
          ? { negativePrompt: input.negativePrompt }
          : {}),
        count: chunk.length,
        ...(input.size ? { size: input.size } : {}),
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
        ...(typeof input.seed === 'number' && model.limits.supportsSeed ? { seed: input.seed } : {}),
        ...(referenceImages.length > 0 ? { referenceImages } : {}),
        modelKey: model.modelKey,
        extraParams: model.defaultParams,
      };

      // 每一次调用都先把计数落库:哪怕紧接着进程崩溃,也能看出"已经发起过付费调用"
      providerCallCount += 1;
      await prisma.generationTask.update({
        where: { id: taskId },
        data: { providerCallCount },
      });

      await reporter.setStage('submitting');
      const submitPromise = (async (): Promise<ImageGenerationOutcome> => {
        try {
          return await adapter.submit(request, creds, {
            timeoutMs: Math.max(5_000, deadline - Date.now()),
          });
        } catch (err) {
          return toProviderFailure(err, '提交生图请求失败');
        }
      })();
      // 请求已经发出,阶段推进到"生成中"(不是等结果回来才推,否则用户会觉得卡住)
      await reporter.setStage('generating');
      let outcome: ImageGenerationOutcome = await submitPromise;

      // ---- 异步供应商:轮询 ----
      if (outcome.kind === 'pending') {
        if (!providerTaskIds.includes(outcome.providerTaskId)) {
          providerTaskIds.push(outcome.providerTaskId);
          await prisma.generationTask.update({
            where: { id: taskId },
            data: { providerTaskIds },
          });
        }
        await reporter.setStage('polling', outcome.progressPercent);
        const polled = await pollUntilSettled({
          adapter,
          providerTaskId: outcome.providerTaskId,
          creds,
          deadline,
          reporter,
          firstDelayMs: outcome.pollAfterMs,
        });
        if (polled.kind === 'exhausted') {
          const disposition = classifyUpstreamFailure({
            failure: {
              errorCode: ERROR_CODES.UPSTREAM_TIMEOUT,
              message: '上游长时间未返回结果,系统将核对后再决定,不会自动重试',
              retryable: false,
            },
            phase: 'poll_exhausted',
            attempt: job.data.attempt,
            providerTaskId: outcome.providerTaskId,
          });
          await applyTerminalDisposition({
            reporter,
            taskId,
            seqs: chunk,
            disposition,
            providerCallCount,
            providerTaskIds,
            upstreamDurationMs,
            queueWaitMs,
          });
          recordFailed(job.queueName);
          return;
        }
        outcome = polled;
      }

      // ---- 失败分类 ----
      if (outcome.kind === 'failed') {
        const disposition = classifyUpstreamFailure({
          failure: outcome,
          phase: 'submit',
          attempt: job.data.attempt,
          providerTaskId: outcome.providerTaskId ?? providerTaskIds.at(-1) ?? null,
        });

        if (disposition.action === 'retry_later') {
          // 限流不算失败,退避重排;已成功的 seq 下次会被幂等跳过
          throw await deferJob(job, token, `上游限流(${disposition.errorCode})`, disposition.delayMs);
        }
        await applyTerminalDisposition({
          reporter,
          taskId,
          seqs: chunk,
          disposition,
          providerCallCount,
          providerTaskIds,
          upstreamDurationMs,
          queueWaitMs,
        });
        if (disposition.action === 'mark_unknown') {
          recordFailed(job.queueName);
          return;
        }
        // 明确失败:本次调用的 seq 记失败,继续处理剩下的分片
        continue;
      }

      // ---- 5. 结果转存 ----
      upstreamDurationMs += outcome.upstreamDurationMs;
      if (outcome.providerTaskId && !providerTaskIds.includes(outcome.providerTaskId)) {
        providerTaskIds.push(outcome.providerTaskId);
      }
      await reporter.setStage('downloading', outcome.progressPercent);

      for (let i = 0; i < chunk.length; i += 1) {
        const seq = chunk[i]!;
        const image = outcome.images[i];
        if (!image) {
          await failResults(
            taskId,
            [seq],
            ERROR_CODES.UPSTREAM_ERROR,
            '上游返回的图片数量少于请求数量',
          );
          continue;
        }
        await persistImageResult({
          taskId,
          userId,
          seq,
          image,
          providerTaskId: outcome.providerTaskId ?? null,
        });
      }
    }

    // ---- 6. 汇总 ----
    // 'checking' 阶段在生图链路上表示"核对转存结果完整性",不是内容检查
    await reporter.setStage('checking');
    const summary = await summarizeTask({
      taskId,
      userId,
      requestedCount: task.requestedCount,
      providerCallCount,
      providerTaskIds,
      upstreamDurationMs,
      queueWaitMs,
    });

    await clearDeferCount(job.id);
    recordProcessed(job.queueName, Date.now() - jobStartedAt);
    log.info(
      `任务 ${taskId} 结束:${summary.status} 成功 ${summary.counts.succeeded} / 失败 ${summary.counts.failed},` +
        `上游调用 ${providerCallCount} 次,上游耗时 ${upstreamDurationMs}ms`,
    );
  } finally {
    // ---- 8. 无论走哪条路径都归还全部闸门 ----
    await held.releaseAll();
  }
}

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

/** 轮询的三种收敛结果:拿到图 / 明确失败 / 次数或时间耗尽 */
type PollResult = ImageCompleted | ProviderFailure | { kind: 'exhausted' };

async function pollUntilSettled(params: {
  adapter: ImageProvider;
  providerTaskId: string;
  creds: ProviderCredentials;
  deadline: number;
  reporter: TaskReporter;
  firstDelayMs?: number;
}): Promise<PollResult> {
  const env = loadEnv();
  const { adapter, providerTaskId, creds, deadline, reporter } = params;

  if (!adapter.poll) {
    return {
      kind: 'failed',
      errorCode: ERROR_CODES.UPSTREAM_ERROR,
      message: '该模型声明为异步出图,但适配器没有实现 poll',
      retryable: false,
      providerTaskId,
    };
  }

  const poll = adapter.poll.bind(adapter);
  let delayMs = params.firstDelayMs ?? env.PROVIDER_POLL_INTERVAL_MS;
  for (let attempt = 1; attempt <= env.PROVIDER_POLL_MAX_ATTEMPTS; attempt += 1) {
    if (Date.now() >= deadline) return { kind: 'exhausted' };
    await sleep(Math.max(500, Math.min(delayMs, deadline - Date.now())));
    if (Date.now() >= deadline) return { kind: 'exhausted' };

    let outcome: PollOutcome;
    try {
      outcome = await poll(providerTaskId, creds, {
        timeoutMs: Math.max(5_000, Math.min(60_000, deadline - Date.now())),
      });
    } catch (err) {
      outcome = toProviderFailure(err, '轮询生图结果失败');
    }

    if (outcome.kind === 'completed') return outcome;
    if (outcome.kind === 'pending') {
      // 只有上游真的给了百分比才会写进 progressPercent
      await reporter.setStage('polling', outcome.progressPercent);
      delayMs = outcome.pollAfterMs ?? env.PROVIDER_POLL_INTERVAL_MS;
      continue;
    }

    // 轮询请求自身失败:轮询是只读且不计费的,可临时错误可继续
    const disposition = classifyUpstreamFailure({
      failure: outcome,
      phase: 'poll',
      attempt,
      providerTaskId,
    });
    if (disposition.action === 'retry_later') {
      delayMs = disposition.delayMs;
      continue;
    }
    return { ...outcome, providerTaskId: outcome.providerTaskId ?? providerTaskId };
  }

  return { kind: 'exhausted' };
}

// ---------------------------------------------------------------------------
// 终态处置
// ---------------------------------------------------------------------------

/** 把终态处置(UNKNOWN / FAILED / TIMEOUT)一次性写入任务与相关结果 */
async function applyTerminalDisposition(params: {
  reporter: TaskReporter;
  taskId: string;
  seqs: number[];
  disposition: Extract<
    ReturnType<typeof classifyUpstreamFailure>,
    { action: 'fail' } | { action: 'mark_unknown' }
  >;
  providerCallCount: number;
  providerTaskIds: string[];
  upstreamDurationMs: number;
  queueWaitMs: number;
}): Promise<void> {
  const { disposition } = params;

  if (disposition.action === 'mark_unknown') {
    // 结果未知:结果行保持 PENDING(不能判失败,上游可能已经出图并计费),
    // 由 maintenance 的 reconcile_unknown_tasks 拿 providerTaskId 核对后再落终态。
    await params.reporter.finish({
      status: TaskStatus.UNKNOWN,
      errorCode: disposition.errorCode,
      errorMessage: disposition.message,
      retryable: false,
      providerCallCount: params.providerCallCount,
      providerTaskIds: params.providerTaskIds,
      upstreamDurationMs: params.upstreamDurationMs,
      queueWaitMs: params.queueWaitMs,
    });
    log.warn(
      `任务 ${params.taskId} 置为 UNKNOWN(${disposition.errorCode}),` +
        `providerTaskId=${disposition.providerTaskId ?? '(无)'},等待核对,不会自动重试`,
    );
    return;
  }

  await failResults(params.taskId, params.seqs, disposition.errorCode, disposition.message);
  const counts = await countResults(params.taskId);
  await params.reporter.finish({
    status: counts.succeeded > 0 ? TaskStatus.PARTIAL : (disposition.taskStatus as TaskStatus),
    errorCode: disposition.errorCode,
    errorMessage: disposition.message,
    retryable: disposition.retryable,
    succeededCount: counts.succeeded,
    failedCount: counts.failed,
    providerCallCount: params.providerCallCount,
    providerTaskIds: params.providerTaskIds,
    upstreamDurationMs: params.upstreamDurationMs,
    queueWaitMs: params.queueWaitMs,
  });
}

// ---------------------------------------------------------------------------
// 参考图
// ---------------------------------------------------------------------------

async function loadReferenceImages(
  userId: string,
  assetIds: string[],
  limits: ModelLimits,
): Promise<ReferenceImage[]> {
  if (assetIds.length === 0 || limits.maxReferenceImages === 0) return [];

  const prisma = getPrisma();
  const s3 = getS3();
  // 必须带归属条件:参考图只能是任务所有者自己的、且处于可用状态
  const assets = await prisma.asset.findMany({
    where: { id: { in: assetIds }, ownerId: userId, status: AssetStatus.ACTIVE },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));

  const out: ReferenceImage[] = [];
  for (const id of assetIds.slice(0, limits.maxReferenceImages)) {
    const asset = byId.get(id);
    if (!asset) {
      log.warn(`参考图 ${id} 不可用(不存在/不属于该用户/未确认上传),已跳过`);
      continue;
    }
    if (limits.maxReferenceBytes > 0 && asset.byteSize > limits.maxReferenceBytes) {
      log.warn(`参考图 ${id} 体积超过该模型上限,已跳过`);
      continue;
    }
    const body = await s3.getBuffer(asset.objectKey);
    if (!body) {
      log.warn(`参考图 ${id} 的对象已不存在,已跳过`);
      continue;
    }
    out.push({ data: body, mimeType: asset.mimeType });
  }
  return out;
}

function chunkSeqs(seqs: number[], perCall: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < seqs.length; i += perCall) {
    chunks.push(seqs.slice(i, i + perCall));
  }
  return chunks;
}
