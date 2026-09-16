'use client';

import type { GenerationTaskView, TaskStatusValue } from '@june/shared';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import { useSse, useSseEvent } from '@/providers/sse-provider';

import { workbenchKeys } from '../lib/keys';

/** 终态集合,与后端 TERMINAL_STATUSES 一致。UNKNOWN 也是终态:要等人工/系统核对,不能盲目重试。 */
export const TERMINAL_TASK_STATUSES: TaskStatusValue[] = [
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'CANCELED',
  'TIMEOUT',
  'UNKNOWN',
];

export function isTerminalStatus(status: TaskStatusValue | undefined): boolean {
  return !!status && TERMINAL_TASK_STATUSES.includes(status);
}

/** SSE 降级时的任务详情轮询间隔 */
const DEGRADED_POLL_MS = 5_000;

export interface TaskDetailResult {
  query: UseQueryResult<GenerationTaskView>;
  /** 实时链路是否处于降级状态(界面需要明确提示,不假装实时) */
  degraded: boolean;
}

/**
 * 任务详情。
 *
 * 刷新恢复:**状态一律从后端接口取**,不依赖本地 state。
 * 页面按 URL 上的 taskId 挂载即恢复,刷新、换标签页、换设备都能看到同一份真实状态。
 *
 * 实时更新:订阅 SSE task.updated 即时刷新状态/阶段/进度;
 * SSE 降级为轮询时(transport 非 'sse'),改为每 5 秒取一次任务详情兜底。
 */
export function useTaskDetail(taskId: string | null): TaskDetailResult {
  const queryClient = useQueryClient();
  const { transport } = useSse();
  const degraded = transport === 'polling' || transport === 'offline';

  const query = useQuery({
    queryKey: workbenchKeys.task(taskId ?? '—'),
    queryFn: () => api.get<GenerationTaskView>(`/generation/tasks/${taskId as string}`),
    enabled: Boolean(taskId),
    refetchInterval: (current) => {
      const data = current.state.data;
      if (!data) return false;
      if (isTerminalStatus(data.status)) return false;
      return degraded ? DEGRADED_POLL_MS : false;
    },
  });

  useSseEvent('task.updated', (event) => {
    if (event.type !== 'task.updated') return;
    if (!taskId || event.taskId !== taskId) return;

    const key = workbenchKeys.task(taskId);
    const cached = queryClient.getQueryData<GenerationTaskView>(key);

    // 先就地更新轻量字段,界面立刻反应;进度为 null 时保持 null,不编造百分比
    if (cached) {
      queryClient.setQueryData<GenerationTaskView>(key, {
        ...cached,
        status: event.status as TaskStatusValue,
        stage: event.stage as GenerationTaskView['stage'],
        progressPercent: event.progressPercent,
        succeededCount: event.succeededCount,
        failedCount: event.failedCount,
        requestedCount: event.requestedCount,
      });
    }

    // 结果明细(图片资产、逐条错误)不在事件里,仍需回源取一次
    void queryClient.invalidateQueries({ queryKey: key });
    if (event.terminal) {
      void queryClient.invalidateQueries({ queryKey: ['workbench', 'tasks', 'list'] });
    }
  });

  return { query, degraded };
}
