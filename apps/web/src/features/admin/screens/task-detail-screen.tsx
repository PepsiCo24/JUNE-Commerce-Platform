'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AdminTaskDetailView } from '@/features/admin/api/types';
import { JsonBlock } from '@/features/admin/components/json-block';
import { formatDuration, formatInteger } from '@/features/admin/lib/format';
import { TASK_TYPE_LABELS } from '@/features/admin/lib/labels';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

export function TaskDetailScreen({ taskId }: { taskId: string }): React.JSX.Element {
  const query = useQuery({
    queryKey: adminKeys.task(taskId),
    queryFn: ({ signal }) => adminApi.get<AdminTaskDetailView>(ADMIN_PATHS.tasks.detail(taskId), { signal }),
  });

  if (query.isPending) return <LoadingState message="加载任务" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const task = query.data;
  const resultColumns: Array<Column<AdminTaskDetailView['results'][number]>> = [
    { key: 'seq', header: '#', numeric: true, render: (row) => row.seq },
    { key: 'status', header: '状态', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'asset', header: '资产', hideOnMobile: true, render: (row) => row.assetId ?? '—' },
    { key: 'error', header: '错误', render: (row) => row.errorMessage ?? row.errorCode ?? '—' },
    { key: 'finished', header: '结束', hideOnMobile: true, render: (row) => formatDateTime(row.finishedAt) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={task.id}
        description={`${TASK_TYPE_LABELS[task.type] ?? task.type} · ${task.userEmail ?? task.userId}`}
        breadcrumbs={[
          { label: '任务', href: '/admin/tasks' },
          { label: task.id },
        ]}
        actions={<StatusBadge status={task.status} />}
      />

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Item label="模型" value={task.modelDisplayName ?? task.modelKey ?? '—'} />
        <Item label="供应商" value={task.providerSlug ?? '—'} />
        <Item label="配置版本" value={formatInteger(task.configVersion)} />
        <Item label="请求 / 成功 / 失败" value={`${task.requestedCount} / ${task.succeededCount} / ${task.failedCount}`} />
        <Item label="上游调用" value={formatInteger(task.providerCallCount)} />
        <Item label="端到端耗时" value={formatDuration(task.totalDurationMs)} />
        <Item label="上游耗时" value={formatDuration(task.upstreamDurationMs)} />
        <Item label="排队" value={formatDuration(task.queueWaitMs)} />
        <Item label="创建" value={formatDateTime(task.createdAt)} />
      </dl>

      {task.errorMessage ? (
        <p className="rounded-md border border-state-danger-border bg-state-danger-bg px-3 py-2 text-sm text-state-danger-fg">
          {task.errorCode ? `${task.errorCode}: ` : ''}
          {task.errorMessage}
        </p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">参数(已脱敏)</h2>
        <JsonBlock value={task.params} />
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">结果</h2>
        <DataTable
          columns={resultColumns}
          rows={task.results}
          rowKey={(row) => row.id}
          emptyMessage="没有结果条目"
        />
      </section>

      <p className="text-xs text-fg-subtle">
        <Link href={`/admin/users/${task.userId}`} className="text-accent hover:underline">
          查看所属用户
        </Link>
      </p>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-default bg-surface p-3">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
    </div>
  );
}
