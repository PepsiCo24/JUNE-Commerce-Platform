/**
 * 任务重排(延迟重入队)辅助。
 *
 * 闸门取不到、上游限流时不能原地 sleep 占着 Worker 槽位——那等于把并发额度浪费在等待上。
 * 正确做法是把任务 moveToDelayed 放回队列,让出槽位给别的任务,实现公平调度。
 *
 * 退避次数记在 Redis(而不是进程内存)里:
 *   BullMQ 的 attemptsMade 不会因为 moveToDelayed 而增加,而任务可能被任意实例接手,
 *   所以计数必须是跨实例共享的,否则重启后退避会退回到最小间隔造成惊群。
 */
import { backoffDelayMs, type QueueName } from '@june/shared';
import { DelayedError, type Job } from 'bullmq';

import { createLogger } from './logger';
import { recordDeferred } from './metrics';
import { getQueue } from './queues';
import { cacheConnection } from './redis';

const log = createLogger('defer');

const DEFER_KEY_TTL_SECONDS = 3_600;
/** 单次重排的最大延迟,避免退避把任务压到很久以后 */
const MAX_DEFER_DELAY_MS = 5 * 60_000;

function deferKey(jobId: string): string {
  return `worker:defer:${jobId}`;
}

async function bumpDeferCount(jobId: string): Promise<number> {
  try {
    const client = cacheConnection();
    const count = await client.incr(deferKey(jobId));
    await client.expire(deferKey(jobId), DEFER_KEY_TTL_SECONDS);
    return count;
  } catch {
    // Redis 不可用时退回到最小退避,不影响主流程
    return 1;
  }
}

export async function clearDeferCount(jobId: string | undefined): Promise<void> {
  if (!jobId) return;
  try {
    await cacheConnection().del(deferKey(jobId));
  } catch {
    // 清理失败无副作用:键自带 TTL
  }
}

/**
 * 把任务延迟重排。
 *
 * `explicitDelayMs` 用于上游给了 Retry-After 的场景;否则用 @june/shared 的 backoffDelayMs
 * (指数退避 + 抖动)按重排次数计算。
 *
 * 调用后必须 `throw` 返回的 DelayedError:BullMQ 靠这个异常识别
 * "任务已被移入 delayed,不要标记完成也不要标记失败"。
 */
export async function deferJob(
  job: Job,
  token: string | undefined,
  reason: string,
  explicitDelayMs?: number,
): Promise<DelayedError> {
  const jobId = job.id ?? 'unknown';
  const count = await bumpDeferCount(jobId);
  const delayMs = Math.min(MAX_DEFER_DELAY_MS, explicitDelayMs ?? backoffDelayMs(count));

  recordDeferred(job.queueName);
  log.info(`任务 ${jobId} 第 ${count} 次重排(${reason}),${delayMs}ms 后重试`);

  if (token) {
    await job.moveToDelayed(Date.now() + delayMs, token);
  } else {
    // 拿不到 token 时(理论上不会发生)退化成重新入队,保证任务不丢
    log.warn(`任务 ${jobId} 缺少处理令牌,改用重新入队`);
    await getQueue(job.queueName as QueueName).add(job.name, job.data, { delay: delayMs });
  }
  return new DelayedError();
}
