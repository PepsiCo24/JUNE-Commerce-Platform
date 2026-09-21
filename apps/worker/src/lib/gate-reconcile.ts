/**
 * 闸门对账(崩溃恢复)。
 *
 * 问题:Worker 被 kill -9 / OOM / 断电时,Redis 里的 INCR 计数没人 DECR。
 * 只靠兜底 TTL 的话,最坏情况下会有整个 TTL 时长的"名额被幽灵任务占着",
 * 极端情况(计数长期只增不减)会把队列永久卡死。
 *
 * 解法:启动时以数据库为权威源重置计数。
 *   - PostgreSQL 里 GenerationTask.status = RUNNING 才是"真的在跑";
 *   - 进程重启后不会有任何任务真的在跑,但同一集群里的**其他** Worker 实例可能在跑,
 *     所以不能直接清零,而是按数据库里的 RUNNING 数量对齐;
 *   - 数据库里残留的 RUNNING(上次崩溃时留下的)会被 reclaimStaleRunningTasks 转成 UNKNOWN,
 *     因为它们可能已经向上游提交并计费,禁止直接重跑。
 */
import { TaskStatus, TaskType } from '@june/db';
import { CONCURRENCY_KEYS } from '@june/shared';

import { loadEnv } from '../config/env';
import { gates } from './concurrency';
import { createLogger } from './logger';
import { getPrisma } from './prisma';

const log = createLogger('gate-reconcile');

const IMAGE_TASK_TYPES: readonly TaskType[] = [TaskType.IMAGE_GENERATE, TaskType.IMAGE_EDIT];

export interface ReconcileReport {
  imageGlobal: number;
  textGlobal: number;
  userKeysSet: number;
  userKeysDropped: number;
  providerKeysSet: number;
  providerKeysDropped: number;
}

/**
 * 用数据库里的真实 RUNNING 任务数重置全局 / 每用户 / 每供应商计数。
 * 幂等,可在启动时与定时任务里反复调用。
 */
export async function reconcileGates(): Promise<ReconcileReport> {
  const prisma = getPrisma();
  const gate = gates();

  const running = await prisma.generationTask.findMany({
    where: { status: TaskStatus.RUNNING },
    select: { userId: true, type: true, providerSlug: true },
  });

  let imageGlobal = 0;
  let textGlobal = 0;
  const perUser = new Map<string, number>();
  const perProvider = new Map<string, number>();

  for (const task of running) {
    const isImage = IMAGE_TASK_TYPES.includes(task.type);
    if (isImage) {
      imageGlobal += 1;
      perUser.set(task.userId, (perUser.get(task.userId) ?? 0) + 1);
    } else {
      textGlobal += 1;
    }
    if (task.providerSlug) {
      perProvider.set(task.providerSlug, (perProvider.get(task.providerSlug) ?? 0) + 1);
    }
  }

  await gate.reset(CONCURRENCY_KEYS.imageGlobalRunning, imageGlobal);
  await gate.reset(CONCURRENCY_KEYS.textGlobalRunning, textGlobal);

  // 每用户:先把权威值写回,再把数据库里已经没有 RUNNING 任务的残留键删掉
  const expectedUserKeys = new Set<string>();
  for (const [userId, count] of perUser) {
    const key = CONCURRENCY_KEYS.imageUserRunning(userId);
    expectedUserKeys.add(key);
    await gate.reset(key, count);
  }
  const staleUserKeys = (await gate.scanKeys(CONCURRENCY_KEYS.imageUserRunning('*'))).filter(
    (key) => !expectedUserKeys.has(key),
  );
  await gate.drop(staleUserKeys);

  const expectedProviderKeys = new Set<string>();
  for (const [slug, count] of perProvider) {
    const key = CONCURRENCY_KEYS.providerRunning(slug);
    expectedProviderKeys.add(key);
    await gate.reset(key, count);
  }
  const staleProviderKeys = (await gate.scanKeys(CONCURRENCY_KEYS.providerRunning('*'))).filter(
    (key) => !expectedProviderKeys.has(key),
  );
  await gate.drop(staleProviderKeys);

  const report: ReconcileReport = {
    imageGlobal,
    textGlobal,
    userKeysSet: perUser.size,
    userKeysDropped: staleUserKeys.length,
    providerKeysSet: perProvider.size,
    providerKeysDropped: staleProviderKeys.length,
  };
  log.info(
    `闸门对账完成:image=${imageGlobal} text=${textGlobal} ` +
      `用户键 ${report.userKeysSet} 写入 / ${report.userKeysDropped} 清理,` +
      `供应商键 ${report.providerKeysSet} 写入 / ${report.providerKeysDropped} 清理`,
  );
  return report;
}

/**
 * 回收上次崩溃留下的 RUNNING 任务。
 *
 * **不重复计费的关键**:这些任务可能已经把请求发给了上游(甚至已经出图并计费),
 * 只是我们没来得及记录结果。因此:
 *   - 已经拿到 providerTaskId(或已产生过上游调用)→ 置 UNKNOWN,交给
 *     maintenance 的 reconcile_unknown_tasks 拿 providerTaskId 去上游核对,**绝不自动重跑**;
 *   - 从未发生过上游调用(providerCallCount = 0 且没有 providerTaskId)→ 退回 QUEUED,
 *     可以安全地重新排队,因为上游根本没被触达、不可能计费。
 *
 * staleBeforeMs 用来避开其他实例正在跑的任务:只回收明显超过单任务超时上限的。
 */
export async function reclaimStaleRunningTasks(): Promise<{ toUnknown: number; toQueued: number }> {
  const env = loadEnv();
  const prisma = getPrisma();

  // 留 2 倍超时的余量,确保不会误伤同集群里其他实例正在处理的任务
  const cutoff = new Date(Date.now() - Math.max(env.TASK_IMAGE_TIMEOUT_MS, env.TASK_TEXT_TIMEOUT_MS) * 2);

  const stale = await prisma.generationTask.findMany({
    where: { status: TaskStatus.RUNNING, startedAt: { lt: cutoff } },
    select: { id: true, providerCallCount: true, providerTaskIds: true },
  });
  if (stale.length === 0) return { toUnknown: 0, toQueued: 0 };

  const maybeBilled = stale.filter((t) => t.providerCallCount > 0 || t.providerTaskIds.length > 0);
  const neverCalled = stale.filter((t) => t.providerCallCount === 0 && t.providerTaskIds.length === 0);

  if (maybeBilled.length > 0) {
    await prisma.generationTask.updateMany({
      where: { id: { in: maybeBilled.map((t) => t.id) }, status: TaskStatus.RUNNING },
      data: {
        status: TaskStatus.UNKNOWN,
        errorCode: 'UPSTREAM_RESULT_UNKNOWN',
        errorMessage: 'Worker 异常退出,上游可能已执行并计费,系统将核对后再决定,不会自动重试',
        retryable: false,
      },
    });
  }
  if (neverCalled.length > 0) {
    await prisma.generationTask.updateMany({
      where: { id: { in: neverCalled.map((t) => t.id) }, status: TaskStatus.RUNNING },
      data: { status: TaskStatus.QUEUED, stage: 'queued', startedAt: null },
    });
  }

  log.warn(
    `回收异常退出遗留的 RUNNING 任务:${maybeBilled.length} 个置 UNKNOWN(待核对),` +
      `${neverCalled.length} 个退回 QUEUED(上游未被触达,可安全重排)`,
  );
  return { toUnknown: maybeBilled.length, toQueued: neverCalled.length };
}
