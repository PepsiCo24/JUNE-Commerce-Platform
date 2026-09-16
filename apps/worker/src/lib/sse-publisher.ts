/**
 * SSE 事件发布。
 *
 * Worker 与 API 是不同进程,任务状态变化通过 Redis Pub/Sub 汇聚到 API 持有的 SSE 连接,
 * 频道名由 @june/shared 的 userSseChannel(userId) 决定(契约唯一来源)。
 *
 * 约定:
 *  - 只推送当前用户有权接收的事件(定向频道,不走 broadcast);
 *  - 绝不推送 API Key、内部系统提示词或任何密文;
 *  - progressPercent 只在上游返回真实百分比时才有值,为 null 时前端只展示阶段文案;
 *  - 未通过内容检查的文案**不进入事件载荷**(事件只带状态与计数)。
 */
import {
  userSseChannel,
  type SseStorageUpdatedEvent,
  type SseTaskUpdatedEvent,
} from '@june/shared';

import { createLogger } from './logger';
import { publisherConnection } from './redis';

const log = createLogger('sse');

/** 终态集合:前端收到 terminal=true 后可停止兜底轮询 */
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELED', 'TIMEOUT', 'UNKNOWN']);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface TaskUpdatePayload {
  taskId: string;
  status: string;
  stage: string;
  progressPercent: number | null;
  succeededCount: number;
  failedCount: number;
  requestedCount: number;
}

/**
 * 推送 task.updated。发布失败不抛错:SSE 是体验增强,
 * 权威状态在 PostgreSQL 的 GenerationTask,前端有轮询兜底。
 */
export async function publishTaskUpdated(userId: string, payload: TaskUpdatePayload): Promise<void> {
  const event: SseTaskUpdatedEvent = {
    type: 'task.updated',
    taskId: payload.taskId,
    status: payload.status,
    stage: payload.stage,
    progressPercent: payload.progressPercent,
    succeededCount: payload.succeededCount,
    failedCount: payload.failedCount,
    requestedCount: payload.requestedCount,
    terminal: isTerminalStatus(payload.status),
  };
  await publish(userId, event);
}

/** 转存生成图后用量发生变化,顺带通知前端刷新存储条 */
export async function publishStorageUpdated(
  userId: string,
  usage: { bytesUsed: bigint; quotaBytes: bigint },
): Promise<void> {
  const event: SseStorageUpdatedEvent = {
    type: 'storage.updated',
    bytesUsed: usage.bytesUsed.toString(),
    quotaBytes: usage.quotaBytes.toString(),
  };
  await publish(userId, event);
}

async function publish(userId: string, event: object): Promise<void> {
  try {
    await publisherConnection().publish(userSseChannel(userId), JSON.stringify(event));
  } catch (err) {
    log.warn(`SSE 发布失败(已忽略,前端有轮询兜底):${(err as Error).message}`);
  }
}
