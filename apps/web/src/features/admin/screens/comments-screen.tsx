'use client';

import { PAGE_SIZE_DEFAULT, type CursorResult } from '@june/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AdminCommentView } from '@/features/admin/api/types';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { toastApiError } from '@/features/admin/lib/errors';
import { compactQuery } from '@/features/admin/lib/query';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { q: '', status: 'ALL', postId: '' };

export function CommentsScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);
  const params = compactQuery({
    q: filters.q,
    status: filters.status,
    postId: filters.postId,
    limit: PAGE_SIZE_DEFAULT,
  });

  const listQuery = useInfiniteQuery({
    queryKey: adminKeys.comments(params),
    queryFn: ({ pageParam, signal }) =>
      adminApi.get<CursorResult<AdminCommentView>>(ADMIN_PATHS.content.comments, {
        signal,
        query: { ...params, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const action = useMutation({
    mutationFn: (input: { id: string; action: 'hide' | 'restore' | 'delete' }) =>
      adminApi.post(ADMIN_PATHS.content.commentAction(input.id), { action: input.action }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'content', 'comments'] }),
    onError: (error) => toastApiError(error, '无法处理评论'),
  });

  const rows = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const columns: Array<Column<AdminCommentView>> = [
    {
      key: 'content',
      header: '内容',
      render: (row) => (
        <div>
          <p className="max-w-md whitespace-pre-wrap text-sm">{row.content}</p>
          <p className="mt-1 text-xs text-fg-muted">{row.authorName} · {row.postTitle}</p>
        </div>
      ),
    },
    { key: 'status', header: '状态', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'created', header: '时间', hideOnMobile: true, render: (row) => formatDateTime(row.createdAt) },
    {
      key: 'actions',
      header: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.status === 'VISIBLE' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const ok = await confirm({ title: '隐藏这条评论?', danger: true, confirmLabel: '隐藏' });
                if (ok) action.mutate({ id: row.id, action: 'hide' });
              }}
            >
              隐藏
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => action.mutate({ id: row.id, action: 'restore' })}>
              恢复
            </Button>
          )}
          {row.status !== 'DELETED' ? (
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                const ok = await confirm({
                  title: '删除这条评论?',
                  danger: true,
                  requireText: '删除',
                  confirmLabel: '删除',
                });
                if (ok) action.mutate({ id: row.id, action: 'delete' });
              }}
            >
              删除
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      {confirmNode}
      <PageHeader title="评论" description="隐藏、恢复、删除。操作写入审计。" />
      <div className="flex flex-wrap items-end gap-3">
        <Input
          placeholder="搜索内容"
          value={filters.q}
          aria-label="搜索评论"
          className="max-w-xs"
          onChange={(event) => setFilters({ q: event.target.value })}
        />
        <div className="w-36">
          <Select
            aria-label="状态"
            value={filters.status}
            onChange={(value) => setFilters({ status: value })}
            options={[
              { value: 'ALL', label: '全部' },
              { value: 'VISIBLE', label: '可见' },
              { value: 'HIDDEN', label: '隐藏' },
              { value: 'DELETED', label: '已删除' },
            ]}
          />
        </div>
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
        emptyMessage="没有评论"
      />
      <LoadMore
        hasMore={Boolean(listQuery.hasNextPage)}
        loading={listQuery.isFetchingNextPage}
        onLoadMore={() => void listQuery.fetchNextPage()}
      />
    </div>
  );
}
