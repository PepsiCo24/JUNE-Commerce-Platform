'use client';

import { PAGE_SIZE_DEFAULT, type AuditLogView, type CursorResult } from '@june/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AuditLogFilterOptions } from '@/features/admin/api/types';
import { JsonBlock } from '@/features/admin/components/json-block';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { compactQuery, dateToIsoEnd, dateToIsoStart } from '@/features/admin/lib/query';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { action: 'ALL', actorId: '', targetType: 'ALL', targetId: '', from: '', to: '' };

export function AuditScreen(): React.JSX.Element {
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);
  const [open, setOpen] = useState<AuditLogView | null>(null);

  const params = compactQuery({
    action: filters.action === 'ALL' ? '' : filters.action,
    actorId: filters.actorId,
    targetType: filters.targetType === 'ALL' ? '' : filters.targetType,
    targetId: filters.targetId,
    from: dateToIsoStart(filters.from),
    to: dateToIsoEnd(filters.to),
    limit: PAGE_SIZE_DEFAULT,
  });

  const optionsQuery = useQuery({
    queryKey: adminKeys.auditLogOptions,
    queryFn: ({ signal }) => adminApi.get<AuditLogFilterOptions>(ADMIN_PATHS.auditLogs.actions, { signal }),
  });

  const listQuery = useInfiniteQuery({
    queryKey: adminKeys.auditLogs(params),
    queryFn: ({ pageParam, signal }) =>
      adminApi.get<CursorResult<AuditLogView>>(ADMIN_PATHS.auditLogs.list, {
        signal,
        query: { ...params, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = listQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const actionOptions = [
    { value: 'ALL', label: '全部动作' },
    ...(optionsQuery.data?.actions ?? []).map((action) => ({ value: action, label: action })),
  ];
  const targetOptions = [
    { value: 'ALL', label: '全部对象' },
    ...(optionsQuery.data?.targetTypes ?? []).map((targetType) => ({ value: targetType, label: targetType })),
  ];

  const columns: Array<Column<AuditLogView>> = [
    { key: 'time', header: '时间', render: (row) => formatDateTime(row.createdAt) },
    {
      key: 'actor',
      header: '操作者',
      render: (row) => (
        <div>
          <p className="text-sm">{row.actorEmail ?? row.actorId ?? '系统'}</p>
          <p className="text-xs text-fg-muted">{row.actorRole ?? '—'}</p>
        </div>
      ),
    },
    { key: 'action', header: '动作', render: (row) => <Badge size="sm">{row.action}</Badge> },
    {
      key: 'target',
      header: '对象',
      hideOnMobile: true,
      render: (row) => (
        <span className="text-xs">
          {row.targetType}
          {row.targetId ? ` · ${row.targetId}` : ''}
        </span>
      ),
    },
    { key: 'result', header: '结果', render: (row) => row.result },
    { key: 'ip', header: 'IP', hideOnMobile: true, render: (row) => row.ip ?? '—' },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="审计" description="只读。审计记录不可修改、不可删除。" />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-52">
          <Select
            aria-label="动作"
            value={filters.action}
            onChange={(value) => setFilters({ action: value })}
            options={actionOptions}
          />
        </div>
        <div className="w-44">
          <Select
            aria-label="对象类型"
            value={filters.targetType}
            onChange={(value) => setFilters({ targetType: value })}
            options={targetOptions}
          />
        </div>
        <Input
          placeholder="操作者 ID"
          aria-label="操作者 ID"
          className="w-44"
          value={filters.actorId}
          onChange={(event) => setFilters({ actorId: event.target.value })}
        />
        <Input
          placeholder="对象 ID"
          aria-label="对象 ID"
          className="w-44"
          value={filters.targetId}
          onChange={(event) => setFilters({ targetId: event.target.value })}
        />
        <Input type="date" aria-label="开始" value={filters.from} onChange={(event) => setFilters({ from: event.target.value })} />
        <Input type="date" aria-label="结束" value={filters.to} onChange={(event) => setFilters({ to: event.target.value })} />
        {isFiltered ? (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            清空筛选
          </Button>
        ) : null}
      </div>

      {listQuery.isError ? <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : null}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        emptyMessage="没有审计记录"
        onRowClick={(row) => setOpen(row)}
      />
      <LoadMore
        hasMore={Boolean(listQuery.hasNextPage)}
        loading={listQuery.isFetchingNextPage}
        onLoadMore={() => void listQuery.fetchNextPage()}
      />

      {open ? (
        <Dialog
          open
          theme="light"
          size="lg"
          title={open.action}
          description={`${open.actorEmail ?? open.actorId ?? '系统'} · ${formatDateTime(open.createdAt)}`}
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
        >
          <div className="space-y-3">
            <p className="text-sm text-fg-muted">
              {open.targetType}
              {open.targetId ? ` · ${open.targetId}` : ''} · {open.result}
            </p>
            <div>
              <p className="mb-1 text-xs text-fg-muted">diff</p>
              <JsonBlock value={open.diff} />
            </div>
            <div>
              <p className="mb-1 text-xs text-fg-muted">metadata</p>
              <JsonBlock value={open.metadata} />
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
