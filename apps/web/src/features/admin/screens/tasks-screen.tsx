'use client';

import { PAGE_SIZE_DEFAULT, TASK_STATUSES, TASK_STATUS_LABELS, type CursorResult } from '@june/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AdminTaskListItem, AdminTaskStatsResponse } from '@/features/admin/api/types';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { formatDuration, formatInteger, formatRate } from '@/features/admin/lib/format';
import { TASK_TYPE_LABELS } from '@/features/admin/lib/labels';
import { compactQuery, dateToIsoEnd, dateToIsoStart } from '@/features/admin/lib/query';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

const FILTERS = {
  userId: '',
  status: 'ALL',
  type: 'ALL',
  providerSlug: '',
  onlyFailed: 'false',
  from: '',
  to: '',
};

const TASK_TYPES = ['IMAGE_GENERATE', 'IMAGE_EDIT', 'TEXT_COPY'] as const;

export function TasksScreen(): React.JSX.Element {
  const router = useRouter();
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);

  const listParams = compactQuery({
    userId: filters.userId,
    status: filters.status,
    type: filters.type,
    providerSlug: filters.providerSlug,
    onlyFailed: filters.onlyFailed,
    from: dateToIsoStart(filters.from),
    to: dateToIsoEnd(filters.to),
    limit: PAGE_SIZE_DEFAULT,
  });

  const statsParams = compactQuery({
    from: dateToIsoStart(filters.from),
    to: dateToIsoEnd(filters.to),
    providerSlug: filters.providerSlug,
  });

  const listQuery = useInfiniteQuery({
    queryKey: adminKeys.tasks(listParams),
    queryFn: ({ pageParam, signal }) =>
      adminApi.get<CursorResult<AdminTaskListItem>>(ADMIN_PATHS.tasks.list, {
        signal,
        query: { ...listParams, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const statsQuery = useQuery({
    queryKey: adminKeys.taskStats(statsParams),
    queryFn: ({ signal }) =>
      adminApi.get<AdminTaskStatsResponse>(ADMIN_PATHS.tasks.stats, { signal, query: statsParams }),
  });

  const rows = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const columns: Array<Column<AdminTaskListItem>> = [
    {
      key: 'id',
      header: '任务',
      render: (row) => (
        <div>
          <p className="font-mono text-xs">{row.id}</p>
          <p className="text-xs text-fg-muted">{row.userEmail ?? row.userId}</p>
        </div>
      ),
    },
    {
      key: 'type',
      header: '类型',
      render: (row) => TASK_TYPE_LABELS[row.type] ?? row.type,
    },
    { key: 'status', header: '状态', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'model',
      header: '模型',
      hideOnMobile: true,
      render: (row) => row.modelDisplayName ?? row.modelKey ?? '—',
    },
    {
      key: 'counts',
      header: '结果',
      numeric: true,
      hideOnMobile: true,
      render: (row) => `${row.succeededCount}/${row.requestedCount}`,
    },
    {
      key: 'duration',
      header: '耗时',
      hideOnMobile: true,
      render: (row) => formatDuration(row.totalDurationMs),
    },
    { key: 'created', header: '创建', hideOnMobile: true, render: (row) => formatDateTime(row.createdAt) },
  ];

  const statsColumns: Array<Column<AdminTaskStatsResponse['rows'][number]>> = [
    { key: 'provider', header: '供应商', render: (row) => row.providerSlug || '—' },
    { key: 'model', header: '模型', render: (row) => row.modelDisplayName ?? row.modelKey },
    { key: 'total', header: '总数', numeric: true, render: (row) => formatInteger(row.total) },
    { key: 'ok', header: '成功', numeric: true, render: (row) => formatInteger(row.succeeded) },
    {
      key: 'rate',
      header: '成功率',
      numeric: true,
      render: (row) => (row.rateDenominator > 0 ? formatRate(row.successRate) : '—'),
    },
    {
      key: 'p95',
      header: '95% 请求耗时',
      numeric: true,
      hideOnMobile: true,
      render: (row) => formatDuration(row.p95UpstreamMs),
    },
    {
      key: 'calls',
      header: '模型调用次数',
      numeric: true,
      hideOnMobile: true,
      render: (row) => formatInteger(row.providerCallCount),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="任务" description="跟踪生成进度、比较模型表现并排查失败原因。" />

      <div className="flex flex-wrap items-end gap-3">
        <Input
          placeholder="用户 ID"
          value={filters.userId}
          aria-label="用户 ID"
          className="w-44"
          onChange={(event) => setFilters({ userId: event.target.value })}
        />
        <div className="w-36">
          <Select
            aria-label="状态"
            value={filters.status}
            onChange={(value) => setFilters({ status: value })}
            options={[
              { value: 'ALL', label: '全部状态' },
              ...TASK_STATUSES.map((status) => ({ value: status, label: TASK_STATUS_LABELS[status] })),
            ]}
          />
        </div>
        <div className="w-36">
          <Select
            aria-label="类型"
            value={filters.type}
            onChange={(value) => setFilters({ type: value })}
            options={[
              { value: 'ALL', label: '全部类型' },
              ...TASK_TYPES.map((type) => ({ value: type, label: TASK_TYPE_LABELS[type] })),
            ]}
          />
        </div>
        <Input
          placeholder="供应商标识"
          value={filters.providerSlug}
          aria-label="供应商"
          className="w-40"
          onChange={(event) => setFilters({ providerSlug: event.target.value })}
        />
        <div className="w-36">
          <Select
            aria-label="仅失败"
            value={filters.onlyFailed}
            onChange={(value) => setFilters({ onlyFailed: value })}
            options={[
              { value: 'false', label: '全部任务' },
              { value: 'true', label: '仅失败' },
            ]}
          />
        </div>
        <Input
          type="date"
          aria-label="开始"
          value={filters.from}
          onChange={(event) => setFilters({ from: event.target.value })}
        />
        <Input
          type="date"
          aria-label="结束"
          value={filters.to}
          onChange={(event) => setFilters({ to: event.target.value })}
        />
        {isFiltered ? (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            清空筛选
          </Button>
        ) : null}
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">按模型统计</h2>
        </div>
        {statsQuery.isError ? (
          <ErrorState error={statsQuery.error} onRetry={() => void statsQuery.refetch()} />
        ) : null}
        <DataTable
          columns={statsColumns}
          rows={statsQuery.data?.rows ?? []}
          rowKey={(row) => `${row.providerSlug}-${row.modelKey}`}
          loading={statsQuery.isPending}
          emptyMessage="区间内没有可统计任务"
        />
      </section>

      {listQuery.isError ? (
        <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
      ) : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        emptyMessage="没有任务记录"
        onRowClick={(row) => router.push(`/admin/tasks/${row.id}`)}
      />
      <LoadMore
        hasMore={Boolean(listQuery.hasNextPage)}
        loading={listQuery.isFetchingNextPage}
        onLoadMore={() => void listQuery.fetchNextPage()}
      />
    </div>
  );
}
