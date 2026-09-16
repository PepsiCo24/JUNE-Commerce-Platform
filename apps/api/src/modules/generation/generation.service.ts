import { Injectable, Logger } from '@nestjs/common';
import {
  AssetKind,
  Prisma,
  ResultStatus,
  TaskStatus,
  TaskType,
  type Asset,
  type GenerationResult,
  type GenerationTask,
  type ModelConfig,
  type ModelProvider,
} from '@june/db';
import {
  CONCURRENCY_KEYS,
  countUpstreamCalls,
  decodeCursor,
  encodeCursor,
  ERROR_CODES,
  QUEUE_NAMES,
  validateImageParamsAgainstLimits,
  type CopyGenerateInput,
  type CopyResultPayload,
  type ContentCheckOutcome,
  type CursorResult,
  type GenerationResultView,
  type GenerationTaskView,
  type ImageGenerateInput,
  type TaskStatusValue,
  type TaskSubmitResponse,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { AssetUrlService } from '../assets/asset-url.service';
import { AssetsService } from '../assets/assets.service';
import { ContentRuleService } from '../content/content-rule.service';
import { ModelResolverService } from '../models/model-resolver.service';
import { QueueProducerService } from '../queue/queue-producer.service';

type TaskWithRelations = GenerationTask & {
  results: Array<GenerationResult & { asset: Asset | null }>;
  modelConfig: (ModelConfig & { provider: ModelProvider }) | null;
};

export interface ImageRetryInput {
  seqs: number[];
  idempotencyKey: string;
}

export interface TaskListQueryInput {
  cursor?: string | undefined;
  limit: number;
  type: 'IMAGE_GENERATE' | 'IMAGE_EDIT' | 'TEXT_COPY' | 'ALL';
  status: 'ALL' | TaskStatusValue;
}

export interface SaveToProductInput {
  productId: string;
  resultIds: string[];
  setAsCover: boolean;
}

export interface SaveToPostInput {
  postId: string;
  resultIds: string[];
}

export interface SaveResultsResponse {
  targetId: string;
  savedCount: number;
  /** 已存在于目标上、本次跳过的资产数(不会重复计引用) */
  skippedCount: number;
}

export interface BatchDownloadItem {
  resultId: string;
  assetId: string;
  fileName: string;
  /** 短时签名地址。打包下载由前端或 Worker 处理,API 不把原图读进内存。 */
  url: string;
}

const IMAGE_TASK_TYPES = [TaskType.IMAGE_GENERATE, TaskType.IMAGE_EDIT] as const;

/** 可以发起重试的任务状态 */
const RETRYABLE_STATUSES: TaskStatus[] = [TaskStatus.FAILED, TaskStatus.PARTIAL, TaskStatus.TIMEOUT];

/** 终态:前端收到后可停止轮询兜底 */
const TERMINAL_STATUSES: TaskStatus[] = [
  TaskStatus.SUCCEEDED,
  TaskStatus.PARTIAL,
  TaskStatus.FAILED,
  TaskStatus.CANCELED,
  TaskStatus.TIMEOUT,
  TaskStatus.UNKNOWN,
];

/**
 * 任务 input 里**不下发前端**的字段。
 * 内部系统提示词与结构化 schema 属于后端资产,查看生成参数时必须剔除。
 */
const INTERNAL_INPUT_KEYS = new Set(['systemPrompt', 'structuredOutputSchema', 'wrappedUserInput']);

/**
 * 生成任务提交与查询。
 *
 * API 的职责边界(见 CONVENTIONS 第 8 节):
 *   参数强校验 -> 配额/并发/队列容量 -> 幂等 -> 入队 -> 立刻返回 taskId。
 * **不在请求线程里做任何上游调用**,真正的生成在 Worker 完成。
 */
@Injectable()
export class GenerationService {
  private readonly logger = new Logger(GenerationService.name);
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queue: QueueProducerService,
    private readonly assets: AssetsService,
    private readonly urls: AssetUrlService,
    private readonly resolver: ModelResolverService,
    private readonly content: ContentRuleService,
  ) {}

  // ===========================================================================
  // 生图提交
  // ===========================================================================

  async submitImage(user: AuthUser, dto: ImageGenerateInput): Promise<TaskSubmitResponse> {
    // 1. 模型裁决。固定模型策略在这里生效:请求里的 modelConfigId 可能被忽略或拒绝。
    //    这一步回源数据库,不读缓存,已停用的模型无法通过。
    const capability = dto.referenceAssetIds.length > 0 ? 'IMAGE_EDIT' : 'TEXT_TO_IMAGE';
    const resolved = await this.resolver.resolveForSubmit({
      capability,
      requestedModelConfigId: dto.modelConfigId,
    });

    // 2. 参考图归属校验:不校验就会出现"引用他人私有图片"的越权
    if (dto.referenceAssetIds.length > 0) {
      await this.assets.assertOwnedActive(user.id, dto.referenceAssetIds, [
        AssetKind.REFERENCE_IMAGE,
        AssetKind.PRODUCT_IMAGE,
        AssetKind.GENERATED_IMAGE,
      ]);
    }

    // 3. 参数强校验。前端也会用同一份函数校验,但后端是最终判定方。
    const issues = validateImageParamsAgainstLimits(
      {
        count: dto.count,
        size: dto.size ?? null,
        aspectRatio: dto.aspectRatio ?? null,
        width: dto.width ?? null,
        height: dto.height ?? null,
        referenceCount: dto.referenceAssetIds.length,
        negativePrompt: dto.negativePrompt ?? null,
        prompt: dto.prompt,
      },
      resolved.limits,
    );
    if (issues.length > 0) {
      throw AppException.badRequest(
        ERROR_CODES.PARAM_EXCEEDS_MODEL_LIMIT,
        `参数超出「${resolved.modelConfig.displayName}」的能力上限`,
        { details: issues },
      );
    }

    // 4. 幂等快路径:网络重试造成的重复提交在这里就被拦下,不会重复计费
    const existing = await this.findByIdempotencyKey(user.id, dto.idempotencyKey);
    if (existing) return this.deduplicatedResponse(existing);

    // 5. 并发闸门与队列容量
    await this.assertImageConcurrency(user.id);
    await this.queue.assertCapacity(QUEUE_NAMES.imageGeneration);

    const seqs = Array.from({ length: dto.count }, (_, i) => i);
    const input: Prisma.InputJsonObject = {
      prompt: dto.prompt,
      negativePrompt: dto.negativePrompt ?? null,
      count: dto.count,
      size: dto.size ?? null,
      aspectRatio: dto.aspectRatio ?? null,
      width: dto.width ?? null,
      height: dto.height ?? null,
      seed: dto.seed ?? null,
      referenceAssetIds: dto.referenceAssetIds,
      // 批量被拆分时每次调用都计入供应商频率限制与计费统计,提交时先给出预估
      estimatedUpstreamCalls: countUpstreamCalls(dto.count, resolved.limits),
    };

    // 6. 建任务 + 预创建结果占位(seq 0..n-1),失败项重试时按 seq 精确定位
    let task: GenerationTask;
    try {
      task = await this.prisma.db.$transaction(async (tx) => {
        const created = await tx.generationTask.create({
          data: {
            userId: user.id,
            type: capability === 'IMAGE_EDIT' ? TaskType.IMAGE_EDIT : TaskType.IMAGE_GENERATE,
            status: TaskStatus.QUEUED,
            stage: 'queued',
            modelConfigId: resolved.modelConfig.id,
            providerSlug: resolved.provider.slug,
            modelKey: resolved.modelConfig.modelKey,
            modelDisplayName: resolved.modelConfig.displayName,
            configVersion: resolved.configVersion,
            idempotencyKey: dto.idempotencyKey,
            input,
            referenceAssetIds: dto.referenceAssetIds,
            referenceCount: dto.referenceAssetIds.length,
            requestedCount: dto.count,
            attempt: 1,
          },
        });
        await tx.generationResult.createMany({
          data: seqs.map((seq) => ({ taskId: created.id, seq, status: ResultStatus.PENDING })),
        });
        return created;
      });
    } catch (err) {
      // 双重幂等的第二道:并发重复提交会撞上 @@unique([userId, idempotencyKey])
      const duplicated = await this.recoverFromDuplicate(err, user.id, dto.idempotencyKey);
      if (duplicated) return this.deduplicatedResponse(duplicated);
      throw err;
    }

    // 7. 入队。jobId 由 taskId + seqs + attempt 组成,BullMQ 侧再去重一次。
    await this.queue.enqueueImageGeneration({
      taskId: task.id,
      userId: user.id,
      seqs,
      configVersion: resolved.configVersion,
      attempt: 1,
    });

    return {
      taskId: task.id,
      status: task.status,
      deduplicated: false,
      queuePosition: await this.queue.approximatePosition(QUEUE_NAMES.imageGeneration),
    };
  }

  // ===========================================================================
  // 失败项重试
  // ===========================================================================

  /**
   * 只重试失败的结果序号。
   *
   * 两条红线:
   *  - 已成功的图片不重复生成,也就不会重复计费;
   *  - 状态为 UNKNOWN 时拒绝重试:上游可能已经扣费出图,必须先核对。
   */
  async retryImage(user: AuthUser, taskId: string, dto: ImageRetryInput): Promise<TaskSubmitResponse> {
    const task = await this.prisma.db.generationTask.findFirst({
      where: { id: taskId, userId: user.id },
      include: { results: true },
    });
    if (!task) throw AppException.notOwner();

    if (task.status === TaskStatus.UNKNOWN) {
      throw AppException.conflict(
        ERROR_CODES.UPSTREAM_RESULT_UNKNOWN,
        '该任务的上游结果尚未确认,系统正在核对,核对完成前不能重试',
      );
    }
    if (!RETRYABLE_STATUSES.includes(task.status)) {
      throw AppException.conflict(ERROR_CODES.TASK_NOT_RETRYABLE);
    }
    if (task.type === TaskType.TEXT_COPY) {
      throw AppException.conflict(ERROR_CODES.TASK_NOT_RETRYABLE, '文案任务请重新提交');
    }

    const requested = new Set(dto.seqs);
    const failedSeqs = task.results
      .filter((r) => r.status === ResultStatus.FAILED)
      .map((r) => r.seq)
      .filter((seq) => requested.size === 0 || requested.has(seq))
      .sort((a, b) => a - b);

    if (failedSeqs.length === 0) {
      throw AppException.conflict(ERROR_CODES.TASK_NOT_RETRYABLE, '该任务没有需要重试的失败项');
    }

    // 重试的幂等:复用同一个 task 就无法依赖数据库唯一约束,改用短期 Redis 键去重
    const claimed = await this.claimRetryKey(taskId, dto.idempotencyKey);
    if (!claimed) {
      return {
        taskId: task.id,
        status: task.status,
        deduplicated: true,
        queuePosition: null,
      };
    }

    await this.assertImageConcurrency(user.id);
    await this.queue.assertCapacity(QUEUE_NAMES.imageGeneration);

    const attempt = task.attempt + 1;
    await this.prisma.db.$transaction(async (tx) => {
      await tx.generationResult.updateMany({
        where: { taskId, seq: { in: failedSeqs } },
        data: { status: ResultStatus.PENDING, errorCode: null, errorMessage: null, finishedAt: null },
      });
      await tx.generationTask.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.QUEUED,
          stage: 'queued',
          attempt,
          errorCode: null,
          errorMessage: null,
          progressPercent: null,
          finishedAt: null,
          // 重试只针对失败项,失败计数按本次重试的数量回退
          failedCount: Math.max(0, task.failedCount - failedSeqs.length),
        },
      });
    });

    await this.queue.enqueueImageGeneration({
      taskId,
      userId: user.id,
      seqs: failedSeqs,
      configVersion: task.configVersion,
      attempt,
    });

    return {
      taskId,
      status: TaskStatus.QUEUED,
      deduplicated: false,
      queuePosition: await this.queue.approximatePosition(QUEUE_NAMES.imageGeneration),
    };
  }

  // ===========================================================================
  // 文案提交
  // ===========================================================================

  async submitCopy(user: AuthUser, dto: CopyGenerateInput): Promise<TaskSubmitResponse> {
    const resolved = await this.resolver.resolveForSubmit({
      capability: 'TEXT',
      requestedModelConfigId: dto.modelConfigId,
    });

    const product = dto.productId ? await this.requireOwnedProduct(user.id, dto.productId) : null;

    const productName = product?.name ?? dto.productName ?? '';
    const productDetails = product?.description ?? dto.productDetails ?? '';

    // 输入检查必须在入队之前:不通过就不该消耗任何上游调用
    const check = await this.content.checkInput(
      {
        productName,
        productDetails,
        prompt: dto.prompt ?? '',
        ...Object.fromEntries(dto.sellingPoints.map((p, i) => [`sellingPoints[${i}]`, p])),
      },
      dto.targetPlatform,
    );
    if (!check.passed) {
      throw AppException.badRequest(ERROR_CODES.CONTENT_BLOCKED_INPUT, undefined, {
        details: check.violations
          .filter((v) => v.action === 'BLOCK')
          .map((v) => ({ path: v.field, message: `${v.ruleName}:命中「${v.matched}」` })),
      });
    }

    const existing = await this.findByIdempotencyKey(user.id, dto.idempotencyKey);
    if (existing) return this.deduplicatedResponse(existing);

    await this.assertTextConcurrency(user.id);
    await this.queue.assertCapacity(QUEUE_NAMES.textGeneration);

    // 系统提示词在提交时定版:规则后续变更不会影响已排队任务的行为,便于复现问题。
    // 该字段只存服务端,查看生成参数时会被剔除(见 sanitizeParams)。
    const systemPrompt = await this.content.buildSystemPrompt(dto.targetPlatform, dto.style);
    const userContent = this.content.wrapUserInput(
      [
        `商品名称:${productName || '(未提供)'}`,
        `商品资料:${productDetails || '(未提供)'}`,
        dto.sellingPoints.length > 0 ? `卖点:\n${dto.sellingPoints.map((p) => `- ${p}`).join('\n')}` : '',
        dto.prompt ? `补充要求:${dto.prompt}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    const input: Prisma.InputJsonObject = {
      productId: dto.productId ?? null,
      productName,
      productDetails,
      sellingPoints: dto.sellingPoints,
      targetPlatform: dto.targetPlatform,
      style: dto.style,
      prompt: dto.prompt ?? '',
      titleCount: dto.titleCount,
      inputCheck: check as unknown as Prisma.InputJsonObject,
      systemPrompt,
      wrappedUserInput: userContent,
      structuredOutputSchema: this.content.getStructuredOutputSchema() as Prisma.InputJsonObject,
    };

    let task: GenerationTask;
    try {
      task = await this.prisma.db.$transaction(async (tx) => {
        const created = await tx.generationTask.create({
          data: {
            userId: user.id,
            type: TaskType.TEXT_COPY,
            status: TaskStatus.QUEUED,
            stage: 'queued',
            modelConfigId: resolved.modelConfig.id,
            providerSlug: resolved.provider.slug,
            modelKey: resolved.modelConfig.modelKey,
            modelDisplayName: resolved.modelConfig.displayName,
            configVersion: resolved.configVersion,
            idempotencyKey: dto.idempotencyKey,
            input,
            requestedCount: 1,
            attempt: 1,
          },
        });
        await tx.generationResult.create({
          data: { taskId: created.id, seq: 0, status: ResultStatus.PENDING },
        });
        return created;
      });
    } catch (err) {
      const duplicated = await this.recoverFromDuplicate(err, user.id, dto.idempotencyKey);
      if (duplicated) return this.deduplicatedResponse(duplicated);
      throw err;
    }

    await this.queue.enqueueTextGeneration({
      taskId: task.id,
      userId: user.id,
      configVersion: resolved.configVersion,
      attempt: 1,
    });

    return {
      taskId: task.id,
      status: task.status,
      deduplicated: false,
      queuePosition: await this.queue.approximatePosition(QUEUE_NAMES.textGeneration),
    };
  }

  // ===========================================================================
  // 查询
  // ===========================================================================

  async getTask(user: AuthUser, taskId: string): Promise<GenerationTaskView> {
    // 归属条件直接写进查询,不做"先查再比对"
    const task = await this.prisma.db.generationTask.findFirst({
      where: { id: taskId, userId: user.id },
      include: {
        results: { include: { asset: true }, orderBy: { seq: 'asc' } },
        modelConfig: { include: { provider: true } },
      },
    });
    if (!task) throw AppException.notOwner();
    return this.toTaskView(task);
  }

  async listTasks(user: AuthUser, query: TaskListQueryInput): Promise<CursorResult<GenerationTaskView>> {
    const where: Prisma.GenerationTaskWhereInput = { userId: user.id };
    if (query.type !== 'ALL') where.type = query.type as TaskType;
    if (query.status !== 'ALL') where.status = query.status as TaskStatus;

    const cursor = query.cursor ? decodeCursor<{ createdAt: string; id: string }>(query.cursor) : null;
    if (cursor) {
      const createdAt = new Date(cursor.createdAt);
      where.OR = [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: cursor.id } },
      ];
    }

    const rows = await this.prisma.db.generationTask.findMany({
      where,
      include: {
        results: { include: { asset: true }, orderBy: { seq: 'asc' } },
        modelConfig: { include: { provider: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    return {
      items: await Promise.all(page.map((row) => this.toTaskView(row))),
      nextCursor:
        hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
      hasMore,
    };
  }

  // ===========================================================================
  // 结果保存与下载
  // ===========================================================================

  /** 保存到商品:复用同一 Asset 引用,不复制文件 */
  async saveResultsToProduct(
    user: AuthUser,
    taskId: string,
    dto: SaveToProductInput,
  ): Promise<SaveResultsResponse> {
    const product = await this.requireOwnedProduct(user.id, dto.productId);
    const assetIds = await this.collectResultAssets(user, taskId, dto.resultIds);

    const fresh = assetIds.filter((id) => !product.imageAssetIds.includes(id));
    if (fresh.length > 0) {
      await this.assets.reuseForBusiness(user.id, fresh);
    }

    const cover = dto.setAsCover ? (assetIds[0] ?? null) : null;
    await this.prisma.db.product.update({
      where: { id: product.id },
      data: {
        imageAssetIds: [...product.imageAssetIds, ...fresh],
        ...(cover ? { coverAssetId: cover } : {}),
      },
    });

    return {
      targetId: product.id,
      savedCount: fresh.length,
      skippedCount: assetIds.length - fresh.length,
    };
  }

  /** 保存到帖子:同样复用引用 */
  async saveResultsToPost(user: AuthUser, taskId: string, dto: SaveToPostInput): Promise<SaveResultsResponse> {
    const post = await this.prisma.db.post.findFirst({
      where: { id: dto.postId, authorId: user.id, deletedAt: null },
    });
    if (!post) throw AppException.notOwner();

    const assetIds = await this.collectResultAssets(user, taskId, dto.resultIds);
    const fresh = assetIds.filter((id) => !post.imageAssetIds.includes(id));
    if (fresh.length > 0) {
      await this.assets.reuseForBusiness(user.id, fresh);
    }

    await this.prisma.db.post.update({
      where: { id: post.id },
      data: { imageAssetIds: [...post.imageAssetIds, ...fresh] },
    });

    return { targetId: post.id, savedCount: fresh.length, skippedCount: assetIds.length - fresh.length };
  }

  /**
   * 批量下载:只返回签名地址列表。
   * 打包(zip)由前端或 Worker 完成,API 绝不把原图读进内存——
   * 8 张 4K 原图同时打包足以让单个请求吃掉几百 MB 内存。
   */
  async downloadBatch(user: AuthUser, taskId: string): Promise<BatchDownloadItem[]> {
    const task = await this.prisma.db.generationTask.findFirst({
      where: { id: taskId, userId: user.id },
      include: { results: { include: { asset: true }, orderBy: { seq: 'asc' } } },
    });
    if (!task) throw AppException.notOwner();

    const items: BatchDownloadItem[] = [];
    for (const result of task.results) {
      if (result.status !== ResultStatus.SUCCEEDED || !result.asset) continue;
      const extension = result.asset.mimeType.split('/')[1] ?? 'png';
      const fileName = `${task.id}-${String(result.seq + 1).padStart(2, '0')}.${extension}`;
      items.push({
        resultId: result.id,
        assetId: result.asset.id,
        fileName,
        url: await this.urls.signDownloadUrl(result.asset.objectKey, fileName),
      });
    }
    return items;
  }

  // ===========================================================================
  // 内部辅助
  // ===========================================================================

  private async findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<GenerationTask | null> {
    return this.prisma.db.generationTask.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
  }

  /** P2002 表示并发提交撞上了唯一约束,取回已存在的任务按去重处理 */
  private async recoverFromDuplicate(
    err: unknown,
    userId: string,
    idempotencyKey: string,
  ): Promise<GenerationTask | null> {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;
    const existing = await this.findByIdempotencyKey(userId, idempotencyKey);
    if (existing) {
      this.logger.debug(`幂等键命中(并发提交)task=${existing.id}`);
    }
    return existing;
  }

  private deduplicatedResponse(task: GenerationTask): TaskSubmitResponse {
    // 命中幂等:既不重复入队,也不重复计费
    return { taskId: task.id, status: task.status, deduplicated: true, queuePosition: null };
  }

  /** 重试去重键。15 分钟内同一 (taskId, idempotencyKey) 只接受一次。 */
  private async claimRetryKey(taskId: string, idempotencyKey: string): Promise<boolean> {
    try {
      const ok = await this.redis.cache.set(
        `retry:${taskId}:${idempotencyKey}`,
        '1',
        'EX',
        900,
        'NX',
      );
      return ok === 'OK';
    } catch (err) {
      // Redis 不可用时不阻断重试,但记录下来:此时幂等保证退化为"尽力而为"
      this.logger.warn(`重试幂等键写入失败,已放行:${(err as Error).message}`);
      return true;
    }
  }

  /**
   * 每用户并发闸门。
   *
   * 数据库计数是**权威值**(Redis 计数器可能因 Worker 异常退出而漂移),
   * Redis 计数器只作为跨进程的快速参考,取两者的较大值,宁严勿松。
   */
  private async assertImageConcurrency(userId: string): Promise<void> {
    const [dbRunning, pending, redisRunning] = await Promise.all([
      this.prisma.db.generationTask.count({
        where: { userId, status: TaskStatus.RUNNING, type: { in: [...IMAGE_TASK_TYPES] } },
      }),
      this.prisma.db.generationTask.count({
        where: { userId, status: TaskStatus.QUEUED, type: { in: [...IMAGE_TASK_TYPES] } },
      }),
      this.readCounter(CONCURRENCY_KEYS.imageUserRunning(userId)),
    ]);

    const running = Math.max(dbRunning, redisRunning);
    if (running > this.env.CONCURRENCY_IMAGE_PER_USER_RUNNING) {
      throw AppException.conflict(
        ERROR_CODES.USER_CONCURRENCY_LIMIT,
        `你已有 ${running} 个任务正在生成,请等待完成后再提交`,
      );
    }
    // 新任务会进入 QUEUED,因此判断的是"加上这一个之后是否超限"
    if (pending + 1 > this.env.CONCURRENCY_IMAGE_PER_USER_PENDING) {
      throw AppException.conflict(
        ERROR_CODES.USER_CONCURRENCY_LIMIT,
        `你已有 ${pending} 个任务在排队(上限 ${this.env.CONCURRENCY_IMAGE_PER_USER_PENDING}),请等待完成后再提交`,
      );
    }
  }

  /** 文案任务同样限制排队深度,避免一个用户把文本队列灌满 */
  private async assertTextConcurrency(userId: string): Promise<void> {
    const pending = await this.prisma.db.generationTask.count({
      where: { userId, status: { in: [TaskStatus.QUEUED, TaskStatus.RUNNING] }, type: TaskType.TEXT_COPY },
    });
    if (pending + 1 > this.env.CONCURRENCY_IMAGE_PER_USER_PENDING) {
      throw AppException.conflict(
        ERROR_CODES.USER_CONCURRENCY_LIMIT,
        `你已有 ${pending} 个文案任务在处理,请等待完成后再提交`,
      );
    }
  }

  private async readCounter(key: string): Promise<number> {
    try {
      const raw = await this.redis.cache.get(key);
      const value = Number(raw ?? 0);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      // 缓存故障时回落到数据库计数,不因此拒绝用户提交
      return 0;
    }
  }

  private async requireOwnedProduct(
    userId: string,
    productId: string,
  ): Promise<{ id: string; name: string; description: string | null; imageAssetIds: string[] }> {
    const product = await this.prisma.db.product.findFirst({
      where: { id: productId, ownerId: userId, deletedAt: null },
      select: { id: true, name: true, description: true, imageAssetIds: true },
    });
    if (!product) throw AppException.notOwner();
    return product;
  }

  /** 取出这批结果对应的资产 id,并确认结果确实属于该用户的该任务 */
  private async collectResultAssets(
    user: AuthUser,
    taskId: string,
    resultIds: string[],
  ): Promise<string[]> {
    const results = await this.prisma.db.generationResult.findMany({
      where: {
        id: { in: [...new Set(resultIds)] },
        taskId,
        task: { userId: user.id },
        status: ResultStatus.SUCCEEDED,
      },
      select: { id: true, assetId: true },
    });

    if (results.length !== new Set(resultIds).size) {
      throw AppException.badRequest(ERROR_CODES.NOT_FOUND, '部分结果不存在、尚未成功或不属于你');
    }

    const assetIds = results
      .map((r) => r.assetId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (assetIds.length === 0) {
      throw AppException.badRequest(ERROR_CODES.NOT_FOUND, '所选结果没有可保存的图片');
    }
    return [...new Set(assetIds)];
  }

  // ---------------------------------------------------------------------------
  // 视图
  // ---------------------------------------------------------------------------

  private async toTaskView(task: TaskWithRelations): Promise<GenerationTaskView> {
    const referenceAssets =
      task.referenceAssetIds.length > 0
        ? await this.prisma.db.asset.findMany({ where: { id: { in: task.referenceAssetIds } } })
        : [];

    const [results, referenceImages] = await Promise.all([
      Promise.all(task.results.map((result) => this.toResultView(result))),
      Promise.all(
        referenceAssets.map(async (asset) => ({
          assetId: asset.id,
          thumbUrl: await this.urls.thumbUrl(asset),
        })),
      ),
    ]);

    const providerKind = task.modelConfig?.provider.kind ?? null;

    return {
      id: task.id,
      type: task.type,
      status: task.status,
      stage: task.stage as GenerationTaskView['stage'],
      // 上游没给真实百分比时保持 null,前端只展示阶段文案,绝不编造进度
      progressPercent: task.progressPercent,
      model: {
        id: task.modelConfigId,
        displayName: task.modelDisplayName ?? '(模型已删除)',
        providerSlug: task.providerSlug ?? 'unknown',
        modelKey: task.modelKey ?? 'unknown',
        isMock: providerKind === 'MOCK' || (task.providerSlug ?? '').toLowerCase().startsWith('mock'),
      },
      params: this.sanitizeParams(task.input),
      requestedCount: task.requestedCount,
      succeededCount: task.succeededCount,
      failedCount: task.failedCount,
      results,
      referenceImages,
      errorCode: task.errorCode,
      errorMessage: task.errorMessage,
      retryable: task.retryable && RETRYABLE_STATUSES.includes(task.status),
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString() ?? null,
      finishedAt: task.finishedAt?.toISOString() ?? null,
      queueWaitMs: task.queueWaitMs,
      upstreamDurationMs: task.upstreamDurationMs,
    };
  }

  private async toResultView(
    result: GenerationResult & { asset: Asset | null },
  ): Promise<GenerationResultView> {
    let asset: GenerationResultView['asset'] = null;
    if (result.asset) {
      const [url, thumbUrl, previewUrl] = await Promise.all([
        this.urls.signObjectKey(result.asset.objectKey, result.asset.visibility === 'PUBLIC'),
        this.urls.thumbUrl(result.asset),
        this.urls.previewUrl(result.asset),
      ]);
      asset = {
        id: result.asset.id,
        url,
        previewUrl,
        thumbUrl,
        width: result.asset.width,
        height: result.asset.height,
        byteSize: result.asset.byteSize,
      };
    }

    return {
      id: result.id,
      seq: result.seq,
      status: result.status,
      asset,
      text: (result.textPayload as CopyResultPayload | null) ?? null,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      check: (result.checkResult as ContentCheckOutcome | null) ?? null,
    };
  }

  /**
   * 生成参数视图。
   * 剔除内部系统提示词、结构化 schema 以及任何看起来像凭据的字段——
   * "查看生成参数"是给用户看输入的,不是内部配置的导出口。
   */
  private sanitizeParams(input: Prisma.JsonValue): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (key.startsWith('_')) continue;
      if (INTERNAL_INPUT_KEYS.has(key)) continue;
      if (/key|secret|token|credential|authorization/i.test(key)) continue;
      out[key] = value;
    }
    return out;
  }

  /** 终态判断,供 SSE 事件与前端停止轮询使用 */
  static isTerminal(status: TaskStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
  }
}
