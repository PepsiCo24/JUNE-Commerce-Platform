/**
 * Worker 侧的队列句柄。
 *
 * Worker 既是消费者也会少量生产:
 *  - 转存生成图后要入队缩略图派生;
 *  - scheduler 注册 maintenance 的 repeatable job。
 *
 * 队列名、载荷类型、保留策略全部来自 @june/shared(与 API 的 QueueProducerService 同一份契约),
 * 保留策略必须与 API 侧一致,否则同一队列会出现两套 removeOnComplete 规则。
 */
import { QUEUE_NAMES, QUEUE_RETENTION, type ImageDeriveJob, type QueueName } from '@june/shared';
import { Queue } from 'bullmq';

import { loadEnv } from '../config/env';
import { createLogger } from './logger';
import { queueConnection } from './redis';

const log = createLogger('queue');

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  const env = loadEnv();
  const queue = new Queue(name, {
    // 复用同一条 Redis 连接,避免每个队列各开一条把连接数打满
    connection: queueConnection(),
    prefix: env.QUEUE_PREFIX,
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
  queue.on('error', (err) => log.error(`队列 ${name} 错误:${err.message}`));
  queues.set(name, queue);
  return queue;
}

/** 派生图是纯计算任务(不涉及上游计费),失败可以安全自动重试 */
export async function enqueueDeriveImage(payload: ImageDeriveJob): Promise<void> {
  await getQueue(QUEUE_NAMES.imageDerive).add('derive', payload, {
    jobId: `derive:${payload.assetId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    priority: 20,
  });
}

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export async function queueCounts(name: QueueName): Promise<QueueCounts> {
  try {
    const counts = await getQueue(name).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
    };
  } catch {
    return { waiting: -1, active: -1, delayed: -1, failed: -1, completed: -1 };
  }
}

export async function closeQueues(): Promise<void> {
  const all = [...queues.values()];
  queues.clear();
  await Promise.allSettled(all.map((q) => q.close()));
}
