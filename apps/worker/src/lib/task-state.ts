/**
 * 任务状态写入与推送。
 *
 * 两条纪律:
 *  1. **stage 每次变化都要落库 + 推 SSE**。前端在没有真实百分比时靠阶段文案给反馈,
 *     阶段不推就等于"卡住不动"。
 *  2. **progressPercent 只在上游返回真实百分比时才写**,其余时刻保持 null。
 *     禁止用"已完成张数 / 总张数"之类的估算冒充进度(docs/CONVENTIONS.md §11)。
 *     writeProgress 只接受显式传入的合法数值,任何 undefined / NaN / 越界都不落库。
 */
import { TaskStatus, type Prisma } from '@june/db';
import { type TaskStage } from '@june/shared';

import { createLogger } from './logger';
import { getPrisma } from './prisma';
import { publishTaskUpdated } from './sse-publisher';

const log = createLogger('task-state');

export interface TaskSnapshot {
  taskId: string;
  userId: string;
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  status: string;
  stage: TaskStage;
  progressPercent: number | null;
}

/** 只有 0~100 的有限整数才是"真实进度",其它一律视为没有进度 */
export function normalizeProgress(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

/**
 * 任务状态报告器。把"写库 + 推 SSE"收在一处,避免某条路径只写库忘了推送。
 */
export class TaskReporter {
  private snapshot: TaskSnapshot;

  constructor(init: TaskSnapshot) {
    this.snapshot = { ...init };
  }

  get current(): TaskSnapshot {
    return { ...this.snapshot };
  }

  /** 推进阶段。progressPercent 不传就保持原值(通常是 null)。 */
  async setStage(stage: TaskStage, upstreamProgress?: unknown): Promise<void> {
    const progress = upstreamProgress === undefined ? this.snapshot.progressPercent : normalizeProgress(upstreamProgress);
    if (this.snapshot.stage === stage && this.snapshot.progressPercent === progress) return;

    this.snapshot.stage = stage;
    this.snapshot.progressPercent = progress;
    await this.persist({ stage, progressPercent: progress });
  }

  async setCounts(succeededCount: number, failedCount: number): Promise<void> {
    this.snapshot.succeededCount = succeededCount;
    this.snapshot.failedCount = failedCount;
    await this.persist({ succeededCount, failedCount });
  }

  /** 落终态。terminal 状态会同时写 finishedAt。 */
  async finish(params: {
    status: TaskStatus;
    stage?: TaskStage;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryable?: boolean;
    succeededCount?: number;
    failedCount?: number;
    upstreamDurationMs?: number | null;
    queueWaitMs?: number | null;
    providerCallCount?: number;
    providerTaskIds?: string[];
  }): Promise<void> {
    const stage: TaskStage = params.stage ?? (params.status === TaskStatus.SUCCEEDED ? 'done' : this.snapshot.stage);
    this.snapshot.status = params.status;
    this.snapshot.stage = stage;
    if (params.succeededCount !== undefined) this.snapshot.succeededCount = params.succeededCount;
    if (params.failedCount !== undefined) this.snapshot.failedCount = params.failedCount;

    await this.persist({
      status: params.status,
      stage,
      finishedAt: new Date(),
      ...(params.errorCode !== undefined ? { errorCode: params.errorCode } : {}),
      ...(params.errorMessage !== undefined ? { errorMessage: params.errorMessage?.slice(0, 2_000) ?? null } : {}),
      ...(params.retryable !== undefined ? { retryable: params.retryable } : {}),
      ...(params.succeededCount !== undefined ? { succeededCount: params.succeededCount } : {}),
      ...(params.failedCount !== undefined ? { failedCount: params.failedCount } : {}),
      ...(params.upstreamDurationMs !== undefined && params.upstreamDurationMs !== null
        ? { upstreamDurationMs: params.upstreamDurationMs }
        : {}),
      ...(params.queueWaitMs !== undefined && params.queueWaitMs !== null
        ? { queueWaitMs: params.queueWaitMs }
        : {}),
      ...(params.providerCallCount !== undefined ? { providerCallCount: params.providerCallCount } : {}),
      ...(params.providerTaskIds !== undefined ? { providerTaskIds: params.providerTaskIds } : {}),
    });
  }

  /** 只推送不写库(例如闸门未取到需要重排时告诉前端"还在排队") */
  async notifyOnly(): Promise<void> {
    await publishTaskUpdated(this.snapshot.userId, {
      taskId: this.snapshot.taskId,
      status: this.snapshot.status,
      stage: this.snapshot.stage,
      progressPercent: this.snapshot.progressPercent,
      succeededCount: this.snapshot.succeededCount,
      failedCount: this.snapshot.failedCount,
      requestedCount: this.snapshot.requestedCount,
    });
  }

  private async persist(data: Prisma.GenerationTaskUpdateInput): Promise<void> {
    try {
      await getPrisma().generationTask.update({ where: { id: this.snapshot.taskId }, data });
    } catch (err) {
      // 任务被用户删除等情况下更新会失败;记录后继续,不让状态写入拖垮整个处理流程
      log.warn(`更新任务 ${this.snapshot.taskId} 状态失败:${(err as Error).message}`);
    }
    await this.notifyOnly();
  }
}
