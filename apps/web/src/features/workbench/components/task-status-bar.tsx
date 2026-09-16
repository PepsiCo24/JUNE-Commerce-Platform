'use client';

import {
  TASK_STAGE_LABELS,
  TASK_STATUS_LABELS,
  type GenerationTaskView,
  type TaskStage,
} from '@june/shared';

import { StatusBadge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';

import { formatDuration } from '../lib/format';

export function TaskStatusBar({
  task,
  degraded,
  queuePosition,
}: {
  task: GenerationTaskView;
  degraded?: boolean;
  queuePosition?: number | null;
}): React.JSX.Element {
  const stageLabel = TASK_STAGE_LABELS[task.stage as TaskStage] ?? task.stage;
  const statusLabel = TASK_STATUS_LABELS[task.status];
  const showPercent = task.progressPercent !== null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={task.status} />
        <span className="text-sm text-fg-muted">{stageLabel}</span>
        {task.requestedCount > 0 ? (
          <span className="tabular text-xs text-fg-subtle">
            {task.succeededCount}/{task.requestedCount} 成功
            {task.failedCount > 0 ? ` · ${task.failedCount} 失败` : ''}
          </span>
        ) : null}
        {queuePosition != null && task.status === 'QUEUED' ? (
          <span className="tabular text-xs text-fg-subtle">队列位置 {queuePosition}</span>
        ) : null}
      </div>

      {task.status === 'QUEUED' || task.status === 'RUNNING' ? (
        <Progress
          value={showPercent ? task.progressPercent : null}
          aria-label={showPercent ? `${statusLabel} ${task.progressPercent}%` : stageLabel}
        />
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-subtle">
        {task.queueWaitMs != null ? <span>排队 {formatDuration(task.queueWaitMs)}</span> : null}
        {task.upstreamDurationMs != null ? <span>上游 {formatDuration(task.upstreamDurationMs)}</span> : null}
        {task.model.isMock ? <span>模拟供应商</span> : <span>{task.model.displayName}</span>}
        {degraded ? <span>实时通道不可用,已改为定时刷新</span> : null}
      </div>

      {task.errorMessage ? <p className="text-sm text-state-danger-fg">{task.errorMessage}</p> : null}
    </div>
  );
}
