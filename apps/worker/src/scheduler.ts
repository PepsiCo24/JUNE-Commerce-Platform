/**
 * 定时任务注册。
 *
 * 用 BullMQ 的 repeatable job(job scheduler)而不是进程内 setInterval:
 *   repeatable job 的调度状态存在 Redis,多实例天然只会产出一份任务,
 *   进程重启也不会漏掉或重复注册。
 *
 * 即便如此,注册动作本身仍然用 Redis 锁包一层:
 *   多个实例同时启动时,并发写同一个 scheduler key 虽然幂等,但会产生无意义的竞争与日志噪音;
 *   加锁后只有一个实例负责注册,其余实例直接跳过。
 *
 * runKey 使用"周期时间戳"而不是随机值:同一周期被重复触发时,
 * maintenance Worker 的 runKey 幂等检查会直接跳过,不会重复计数或重复扣用量。
 */
import { QUEUE_NAMES, type MaintenanceJob, type MaintenanceJobKind } from '@june/shared';

import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { getQueue } from './lib/queues';
import { withLock } from './lib/redis';

const log = createLogger('scheduler');

const SCHEDULER_LOCK_KEY = 'worker:scheduler:register';

interface ScheduleSpec {
  kind: MaintenanceJobKind;
  /** cron 表达式(BullMQ 的 repeat.pattern) */
  pattern: string;
  limit: number;
  /** 周期时长(毫秒),用于生成对齐周期的 runKey */
  periodMs: number;
}

/**
 * 计划表。频率依据:
 *  - 热门分 5 分钟一次,与 HOT_SCORE_WEIGHTS.recomputeIntervalSeconds 一致;
 *  - UNKNOWN 核对 10 分钟一次:既能较快给用户结论,又不会频繁打扰上游;
 *  - 清理类每天凌晨错峰执行,避免同时抢占数据库与对象存储带宽。
 */
const SCHEDULES: ScheduleSpec[] = [
  { kind: 'recompute_hot_scores', pattern: '*/5 * * * *', limit: 10_000, periodMs: 5 * 60_000 },
  { kind: 'reconcile_unknown_tasks', pattern: '*/10 * * * *', limit: 100, periodMs: 10 * 60_000 },
  { kind: 'cleanup_expired_upload', pattern: '15 3 * * *', limit: 2_000, periodMs: 86_400_000 },
  { kind: 'cleanup_orphan_asset', pattern: '30 3 * * *', limit: 2_000, periodMs: 86_400_000 },
  { kind: 'purge_recycled_asset', pattern: '45 3 * * *', limit: 2_000, periodMs: 86_400_000 },
  { kind: 'prune_queue_records', pattern: '10 4 * * *', limit: 5_000, periodMs: 86_400_000 },
  { kind: 'prune_sessions', pattern: '20 4 * * *', limit: 10_000, periodMs: 86_400_000 },
];

export async function registerSchedules(): Promise<void> {
  const env = loadEnv();
  const acquired = await withLock(SCHEDULER_LOCK_KEY, env.WORKER_SCHEDULER_LOCK_MS, async () => {
    const queue = getQueue(QUEUE_NAMES.maintenance);
    for (const spec of SCHEDULES) {
      const payload: MaintenanceJob = {
        kind: spec.kind,
        // 定时任务默认真执行;需要预览时由管理员在后台手动触发 dryRun
        dryRun: false,
        limit: spec.limit,
        triggeredBy: 'scheduler',
      };
      // upsertJobScheduler 幂等:同名 scheduler 重复注册只会更新配置
      await queue.upsertJobScheduler(
        `sched:${spec.kind}`,
        { pattern: spec.pattern },
        {
          name: spec.kind,
          data: payload,
          opts: { attempts: 1, priority: 30 },
        },
      );
      log.info(`已注册定时任务 ${spec.kind}:${spec.pattern}`);
    }
    return true;
  });

  if (!acquired) {
    log.info('定时任务已由其他实例注册,本实例跳过');
  }
}

/**
 * 给定时产出的任务补上按周期对齐的 runKey。
 *
 * BullMQ 的 scheduler 在 data 里带的是注册时的静态载荷,没有"本次周期"的信息,
 * 因此 Worker 侧在处理前用这个函数把 runKey 补齐:同一周期内的重复触发
 * (例如手动补跑、实例重启后的补偿调度)会命中同一个 runKey 而被幂等跳过。
 */
export function withPeriodRunKey(job: MaintenanceJob, now = Date.now()): MaintenanceJob {
  if (job.runKey) return job;
  const spec = SCHEDULES.find((s) => s.kind === job.kind);
  if (!spec || job.triggeredBy !== 'scheduler') return job;
  const bucket = Math.floor(now / spec.periodMs);
  return { ...job, runKey: `period-${bucket}` };
}

export { SCHEDULES };
