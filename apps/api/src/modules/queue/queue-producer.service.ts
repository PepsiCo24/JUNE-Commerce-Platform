import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ERROR_CODES,
  QUEUE_NAMES,
  QUEUE_RETENTION,
  type ImageDeriveJob,
  type ImageGenerationJob,
  type MaintenanceJob,
  type ProductImportJob,
  type QueueName,
  type TextGenerationJob,
} from '@june/shared';
import { Queue } from 'bullmq';

import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';
import { RedisService } from '../../infra/redis/redis.service';

/**
 * 队列生产者。
 *
 * API 只负责把耗时工作投递出去并立刻返回,绝不在请求线程里跑生图、
 * 大图压缩或大批量导入。所有队列都设置保留策略,避免 Redis 无界增长。
 */
@Injectable()
export class QueueProducerService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueProducerService.name);
  private readonly env = loadEnv();
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly redis: RedisService) {}

  private queueFor(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const queue = new Queue(name, {
      // 复用同一条 Redis 连接实例,避免每个队列各开一条连接把连接数打满
      connection: this.redis.queue,
      prefix: this.env.QUEUE_PREFIX,
      defaultJobOptions: {
        removeOnComplete: {
          count: QUEUE_RETENTION.completedCount,
          age: QUEUE_RETENTION.completedAgeSeconds,
        },
        removeOnFail: {
          count: QUEUE_RETENTION.failedCount,
          age: QUEUE_RETENTION.failedAgeSeconds,
        },
      },
    });
    queue.on('error', (err) => this.logger.error(`队列 ${name} 错误:${err.message}`));
    this.queues.set(name, queue);
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }

  // ---------------------------------------------------------------------------
  // 投递
  // ---------------------------------------------------------------------------

  /**
   * 生图任务。
   * jobId 使用 taskId + 序号集合,BullMQ 会天然去重,配合数据库唯一约束形成双重幂等。
   */
  async enqueueImageGeneration(payload: ImageGenerationJob): Promise<void> {
    const queue = this.queueFor(QUEUE_NAMES.imageGeneration);
    await queue.add('generate', payload, {
      jobId: `${payload.taskId}:${payload.seqs.join('-')}:${payload.attempt}`,
      // 重试由 Worker 内部按错误类型决定(付费调用不能盲目重试),这里不设自动重试
      attempts: 1,
      priority: 10,
    });
  }

  async enqueueTextGeneration(payload: TextGenerationJob): Promise<void> {
    const queue = this.queueFor(QUEUE_NAMES.textGeneration);
    await queue.add('generate', payload, {
      jobId: `${payload.taskId}:${payload.attempt}`,
      attempts: 1,
      priority: 5,
    });
  }

  /** 缩略图 / 预览图派生。失败可安全重试(纯计算,无外部计费)。 */
  async enqueueDeriveImage(payload: ImageDeriveJob): Promise<void> {
    const queue = this.queueFor(QUEUE_NAMES.imageDerive);
    await queue.add('derive', payload, {
      jobId: `derive:${payload.assetId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      priority: 20,
    });
  }

  async enqueueProductImport(payload: ProductImportJob): Promise<void> {
    const queue = this.queueFor(QUEUE_NAMES.productImport);
    await queue.add('import', payload, {
      jobId: `import:${payload.importJobId}`,
      attempts: 1,
      priority: 15,
    });
  }

  async enqueueMaintenance(payload: MaintenanceJob): Promise<void> {
    const queue = this.queueFor(QUEUE_NAMES.maintenance);
    await queue.add(payload.kind, payload, {
      // 带 runKey 时可幂等重跑:相同 runKey 不会重复入队
      ...(payload.runKey ? { jobId: `maint:${payload.kind}:${payload.runKey}` } : {}),
      attempts: 1,
      priority: 30,
    });
  }

  // ---------------------------------------------------------------------------
  // 容量与位置
  // ---------------------------------------------------------------------------

  /** 队列深度(等待 + 延迟),用于满载反馈 */
  async depth(name: QueueName): Promise<number> {
    const queue = this.queueFor(name);
    const counts = await queue.getJobCounts('waiting', 'delayed', 'prioritized');
    return (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
  }

  /** 满载检查。超过上限时拒绝新提交并给出明确反馈,而不是无声堆积。 */
  async assertCapacity(name: QueueName): Promise<void> {
    const limit =
      name === QUEUE_NAMES.imageGeneration
        ? this.env.QUEUE_MAX_DEPTH_IMAGE
        : name === QUEUE_NAMES.textGeneration
          ? this.env.QUEUE_MAX_DEPTH_TEXT
          : Number.MAX_SAFE_INTEGER;

    if (limit === Number.MAX_SAFE_INTEGER) return;

    const depth = await this.depth(name);
    if (depth >= limit) {
      throw AppException.badRequest(
        ERROR_CODES.QUEUE_FULL,
        `任务队列已满(${depth}/${limit}),请稍后再提交`,
      );
    }
  }

  /** 大致排队位置,仅用于界面提示,不保证精确 */
  async approximatePosition(name: QueueName): Promise<number | null> {
    try {
      return await this.depth(name);
    } catch {
      return null;
    }
  }

  async healthSnapshot(): Promise<Record<string, { waiting: number; active: number; failed: number }>> {
    const out: Record<string, { waiting: number; active: number; failed: number }> = {};
    for (const name of Object.values(QUEUE_NAMES)) {
      try {
        const counts = await this.queueFor(name).getJobCounts('waiting', 'active', 'failed');
        out[name] = {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
        };
      } catch {
        out[name] = { waiting: -1, active: -1, failed: -1 };
      }
    }
    return out;
  }
}
