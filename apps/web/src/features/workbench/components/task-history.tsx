'use client';

import { TASK_STATUSES, TASK_STATUS_LABELS, type GenerationTaskView, type TaskStatusValue } from '@june/shared';
import { History } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { LoadMore } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import type { Column } from '@/components/ui/table';
import { DataTable } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

import { useTaskList, type TaskListType } from '../hooks/use-task-list';
import { TASK_TYPE_LABEL } from '../lib/format';

export function TaskHistory({
  title,
  description,
  fixedType,
  detailHref,
}: {
  title: string;
  description: string;
  fixedType?: TaskListType;
  detailHref: (task: GenerationTaskView) => string;
}): React.JSX.Element {
  const [type, setType] = useState<TaskListType>(fixedType ?? 'ALL');
  const [status, setStatus] = useState<'ALL' | TaskStatusValue>('ALL');
  const list = useTaskList({ type: fixedType ?? type, status });

  const columns = useMemo<Array<Column<GenerationTaskView>>>(
    () => [
      {
        key: 'type',
        header: '类型',
        render: (row) => TASK_TYPE_LABEL[row.type] ?? row.type,
      },
      {
        key: 'status',
        header: '状态',
        render: (row) => <StatusBadge status={row.status} />,
      },
      {
        key: 'model',
        header: '模型',
        hideOnMobile: true,
        render: (row) => row.model.displayName,
      },
      {
        key: 'count',
        header: '结果',
        numeric: true,
        render: (row) => `${row.succeededCount}/${row.requestedCount}`,
      },
      {
        key: 'createdAt',
        header: '提交时间',
        hideOnMobile: true,
        render: (row) => formatDateTime(row.createdAt),
      },
      {
        key: 'action',
        header: '',
        render: (row) => (
          <Link href={detailHref(row)} className="text-sm text-accent hover:underline">
            查看
          </Link>
        ),
      },
    ],
    [detailHref],
  );

  return (
    <div className="space-y-4">
      <PageHeader title={title} description={description} />
      <div className="flex flex-wrap gap-3">
        {fixedType ? null : (
          <Select
            aria-label="任务类型"
            value={type}
            onChange={(value) => setType(value as TaskListType)}
            options={[
              { value: 'ALL', label: '全部类型' },
              { value: 'IMAGE_GENERATE', label: '生图' },
              { value: 'TEXT_COPY', label: '文案' },
            ]}
          />
        )}
        <Select
          aria-label="任务状态"
          value={status}
          onChange={(value) => setStatus(value as 'ALL' | TaskStatusValue)}
          options={[
            { value: 'ALL', label: '全部状态' },
            ...TASK_STATUSES.map((item) => ({ value: item, label: TASK_STATUS_LABELS[item] })),
          ]}
        />
      </div>

      {list.isError ? (
        <ErrorState error={list.error} onRetry={list.refetch} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={list.items}
            rowKey={(row) => row.id}
            loading={list.isLoading}
            emptyMessage={
              <EmptyState icon={<History size={22} />} title="暂无任务" description="提交生成后会出现在这里。" />
            }
          />
          {!list.isLoading && list.items.length > 0 ? (
            <LoadMore hasMore={list.hasMore} loading={list.isFetchingNextPage} onLoadMore={list.loadMore} />
          ) : null}
        </>
      )}
    </div>
  );
}
