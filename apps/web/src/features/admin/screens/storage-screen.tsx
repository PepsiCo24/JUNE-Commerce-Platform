'use client';

import { PAGE_SIZE_DEFAULT, type CleanupRunView, type CursorResult } from '@june/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AdminStorageOverviewView, QuotaBounds } from '@/features/admin/api/types';
import { TrendChart } from '@/features/admin/components/trend-chart';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { toastApiError } from '@/features/admin/lib/errors';
import { bytesToNumber, formatBytes, formatInteger, gbToBytes } from '@/features/admin/lib/format';
import { CLEANUP_KIND_LABELS } from '@/features/admin/lib/labels';
import { compactQuery } from '@/features/admin/lib/query';
import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { Switch } from '@/components/ui/toggle';
import { InfoHint } from '@/components/ui/tooltip';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { kind: 'ALL' };
const CLEANUP_KINDS = ['orphan_asset', 'expired_upload', 'recycled_asset', 'queue_record'] as const;

export function StorageScreen(): React.JSX.Element {
  const { user } = useAdminAuth();
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const { filters, setFilters } = useUrlFilters(FILTERS);
  const [quotaUserId, setQuotaUserId] = useState('');
  const [quotaGb, setQuotaGb] = useState('');
  const [cleanupKind, setCleanupKind] = useState<(typeof CLEANUP_KINDS)[number]>('orphan_asset');
  const [dryRun, setDryRun] = useState(true);
  const [limit, setLimit] = useState('500');

  const overviewQuery = useQuery({
    queryKey: adminKeys.storageOverview({ topN: 10 }),
    queryFn: ({ signal }) =>
      adminApi.get<AdminStorageOverviewView>(ADMIN_PATHS.storage.overview, { signal, query: { topN: 10 } }),
  });

  const boundsQuery = useQuery({
    queryKey: adminKeys.storageQuotaBounds,
    queryFn: ({ signal }) => adminApi.get<QuotaBounds>(ADMIN_PATHS.storage.quotaBounds, { signal }),
  });

  const runParams = compactQuery({ kind: filters.kind, limit: PAGE_SIZE_DEFAULT });
  const runsQuery = useInfiniteQuery({
    queryKey: adminKeys.cleanupRuns(runParams),
    queryFn: ({ pageParam, signal }) =>
      adminApi.get<CursorResult<CleanupRunView>>(ADMIN_PATHS.storage.cleanupRuns, {
        signal,
        query: { ...runParams, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const quotaMutation = useMutation({
    mutationFn: (input: { userId: string; quotaBytes: string }) =>
      adminApi.put(ADMIN_PATHS.storage.quota(input.userId), { quotaBytes: input.quotaBytes }),
    onSuccess: () => {
      toast.success('已更新配额');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'storage'] });
    },
    onError: (error) => toastApiError(error, '无法更新配额'),
  });

  const cleanupMutation = useMutation({
    mutationFn: () =>
      adminApi.post<CleanupRunView>(ADMIN_PATHS.storage.cleanup, {
        kind: cleanupKind,
        dryRun,
        limit: Number(limit) || 500,
      }),
    onSuccess: (run) => {
      toast.success(run.dryRun ? '已入队预览清理' : '已入队清理任务');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'storage'] });
    },
    onError: (error) => toastApiError(error, '无法触发清理'),
  });

  if (overviewQuery.isPending) return <LoadingState message="加载存储概览" />;
  if (overviewQuery.isError) {
    return <ErrorState error={overviewQuery.error} onRetry={() => void overviewQuery.refetch()} />;
  }

  const data = overviewQuery.data;
  const growth = data.growth30d.map((point) => ({ date: point.date, bytes: bytesToNumber(point.bytes) }));
  const runs = runsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const topColumns: Array<Column<AdminStorageOverviewView['topUsers'][number]>> = [
    { key: 'email', header: '用户', render: (row) => row.email },
    { key: 'bytes', header: '用量', numeric: true, render: (row) => formatBytes(row.bytesUsed) },
    { key: 'count', header: '资产数', numeric: true, hideOnMobile: true, render: (row) => formatInteger(row.assetCount) },
  ];

  const runColumns: Array<Column<CleanupRunView>> = [
    { key: 'kind', header: '类型', render: (row) => CLEANUP_KIND_LABELS[row.kind] ?? row.kind },
    { key: 'mode', header: '模式', render: (row) => (row.dryRun ? '预览' : '执行') },
    { key: 'status', header: '状态', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'matched', header: '匹配', numeric: true, render: (row) => formatInteger(row.matched) },
    { key: 'affected', header: '影响', numeric: true, render: (row) => formatInteger(row.affected) },
    { key: 'freed', header: '释放', numeric: true, hideOnMobile: true, render: (row) => formatBytes(row.freedBytes) },
    { key: 'started', header: '开始', hideOnMobile: true, render: (row) => formatDateTime(row.startedAt) },
  ];

  return (
    <div className="space-y-6">
      {confirmNode}
      <PageHeader title="存储" description="用量、配额与清理。清理只入队,由 Worker 执行。" />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="总量" value={formatBytes(data.totalBytes)} definition={data.definitions.totalBytes} />
        <Metric label="活跃" value={formatBytes(data.activeBytes)} definition={data.definitions.activeBytes} />
        <Metric label="回收站" value={formatBytes(data.recycledBytes)} definition={data.definitions.recycledBytes} />
        <Metric label="孤儿" value={formatBytes(data.orphanBytes)} definition={data.definitions.orphanBytes} />
      </section>

      <p className="text-sm text-fg-muted">
        待物理清除 {formatInteger(data.pendingCleanup.dueAssetCount)} 个 / {formatBytes(data.pendingCleanup.dueBytes)}
        ,回收期 {data.pendingCleanup.recycleDays} 天
      </p>

      <TrendChart
        data={growth}
        series={[{ key: 'bytes', name: '新增存储', colorClass: 'purple' }]}
        kind="bytes"
        definition={data.definitions.growth30d}
      />

      <section className="space-y-3">
        <h2 className="text-base font-semibold">用量 Top</h2>
        <DataTable
          columns={topColumns}
          rows={data.topUsers}
          rowKey={(row) => row.userId}
          emptyMessage="没有用量数据"
        />
      </section>

      {data.quotaExceededUsers.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">配额超限</h2>
          <ul className="space-y-1 text-sm">
            {data.quotaExceededUsers.map((item) => (
              <li key={item.userId}>
                {item.email}: {formatBytes(item.bytesUsed)} / {formatBytes(item.quotaBytes)} (超{' '}
                {formatBytes(item.overBytes)})
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {user?.isSuperAdmin ? (
        <>
          <section className="space-y-3 rounded-lg border border-border-default bg-surface p-4">
            <h2 className="text-base font-semibold">调整用户配额</h2>
            <p className="text-xs text-fg-muted">
              区间 {formatBytes(boundsQuery.data?.min)} ~ {formatBytes(boundsQuery.data?.max)}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="用户 ID" htmlFor="quota-user">
                <Input id="quota-user" value={quotaUserId} onChange={(event) => setQuotaUserId(event.target.value)} />
              </Field>
              <Field label="配额 (GB)" htmlFor="quota-gb">
                <Input id="quota-gb" value={quotaGb} onChange={(event) => setQuotaGb(event.target.value)} />
              </Field>
              <Button
                loading={quotaMutation.isPending}
                onClick={async () => {
                  const bytes = gbToBytes(quotaGb);
                  if (!quotaUserId || !bytes) return;
                  const ok = await confirm({
                    title: '调整该用户配额?',
                    description: `将配额设为 ${quotaGb} GB(${bytes} 字节)。`,
                    confirmLabel: '更新配额',
                  });
                  if (ok) quotaMutation.mutate({ userId: quotaUserId, quotaBytes: bytes });
                }}
              >
                保存配额
              </Button>
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-border-default bg-surface p-4">
            <h2 className="text-base font-semibold">触发清理</h2>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-44">
                <Select
                  aria-label="清理类型"
                  value={cleanupKind}
                  onChange={(value) => setCleanupKind(value as (typeof CLEANUP_KINDS)[number])}
                  options={CLEANUP_KINDS.map((kind) => ({ value: kind, label: CLEANUP_KIND_LABELS[kind] }))}
                />
              </div>
              <Field label="单次上限" htmlFor="cleanup-limit">
                <Input id="cleanup-limit" type="number" min={1} max={10000} value={limit} onChange={(event) => setLimit(event.target.value)} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={dryRun} onChange={setDryRun} /> 预览(不删除)
              </label>
              <Button
                variant={dryRun ? 'secondary' : 'danger'}
                loading={cleanupMutation.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: dryRun ? '入队预览清理?' : '入队真实清理?',
                    description: dryRun ? 'Worker 只统计不删除。' : '将实际删除匹配的对象。只入队,不在 API 同步执行。',
                    danger: !dryRun,
                    requireText: dryRun ? undefined : 'CLEANUP',
                    confirmLabel: dryRun ? '预览' : '清理',
                  });
                  if (ok) cleanupMutation.mutate();
                }}
              >
                {dryRun ? '预览清理' : '执行清理'}
              </Button>
            </div>
          </section>
        </>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="text-base font-semibold">清理历史</h2>
          <div className="w-44">
            <Select
              aria-label="清理类型筛选"
              value={filters.kind}
              onChange={(value) => setFilters({ kind: value })}
              options={[
                { value: 'ALL', label: '全部类型' },
                ...CLEANUP_KINDS.map((kind) => ({ value: kind, label: CLEANUP_KIND_LABELS[kind] })),
              ]}
            />
          </div>
        </div>
        {runsQuery.isError ? <ErrorState error={runsQuery.error} onRetry={() => void runsQuery.refetch()} /> : null}
        <DataTable
          columns={runColumns}
          rows={runs}
          rowKey={(row) => row.id}
          loading={runsQuery.isPending}
          emptyMessage="没有清理记录"
        />
        <LoadMore
          hasMore={Boolean(runsQuery.hasNextPage)}
          loading={runsQuery.isFetchingNextPage}
          onLoadMore={() => void runsQuery.fetchNextPage()}
        />
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  definition,
}: {
  label: string;
  value: string;
  definition: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-default bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-fg-muted">{label}</p>
        <InfoHint>{definition}</InfoHint>
      </div>
      <p className="mt-2 text-xl font-semibold tabular">{value}</p>
    </div>
  );
}

