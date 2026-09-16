'use client';

import { PAGE_SIZE_DEFAULT, type CursorResult } from '@june/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AdminPostView } from '@/features/admin/api/types';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { toastApiError } from '@/features/admin/lib/errors';
import { compactQuery } from '@/features/admin/lib/query';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { q: '', status: 'ALL', pinned: 'ALL', authorId: '' };

export function PostsScreen(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);

  const params = compactQuery({
    q: filters.q,
    status: filters.status,
    pinned: filters.pinned,
    authorId: filters.authorId,
    limit: PAGE_SIZE_DEFAULT,
  });

  const listQuery = useInfiniteQuery({
    queryKey: adminKeys.posts(params),
    queryFn: ({ pageParam, signal }) =>
      adminApi.get<CursorResult<AdminPostView>>(ADMIN_PATHS.content.posts, {
        signal,
        query: { ...params, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const visibility = useMutation({
    mutationFn: (input: { id: string; action: 'hide' | 'restore' | 'delete' }) =>
      adminApi.post(ADMIN_PATHS.content.postVisibility(input.id), { action: input.action }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'content'] }),
    onError: (error) => toastApiError(error, '无法更新帖子可见性'),
  });

  const pin = useMutation({
    mutationFn: (input: { id: string; pinned: boolean; order?: number }) =>
      adminApi.post(ADMIN_PATHS.content.postPin(input.id), { pinned: input.pinned, order: input.order }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'content'] }),
    onError: (error) => toastApiError(error, '无法更新置顶'),
  });

  const reorder = useMutation({
    mutationFn: (items: Array<{ postId: string; order: number }>) =>
      adminApi.put(ADMIN_PATHS.content.pinReorder, { items }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'content'] }),
    onError: (error) => toastApiError(error, '无法调整置顶顺序'),
  });

  const rows = listQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const pinned = rows.filter((row) => row.isPinned).sort((a, b) => (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0));

  const columns: Array<Column<AdminPostView>> = [
    {
      key: 'title',
      header: '标题',
      render: (row) => (
        <div>
          <p className="font-medium">{row.title}</p>
          <p className="text-xs text-fg-muted">{row.authorName} · {row.authorEmail}</p>
        </div>
      ),
    },
    { key: 'status', header: '状态', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'pin',
      header: '置顶',
      render: (row) => (row.isPinned ? <Badge size="sm" tone="accent">#{row.pinnedOrder ?? 0}</Badge> : '—'),
    },
    { key: 'likes', header: '赞', numeric: true, hideOnMobile: true, render: (row) => row.likeCount },
    { key: 'comments', header: '评', numeric: true, hideOnMobile: true, render: (row) => row.commentCount },
    { key: 'updated', header: '更新', hideOnMobile: true, render: (row) => formatDateTime(row.updatedAt) },
    {
      key: 'actions',
      header: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1" onClick={(event) => event.stopPropagation()}>
          {row.status !== 'HIDDEN' && row.status !== 'DELETED' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const ok = await confirm({ title: '隐藏这篇帖子?', danger: true, confirmLabel: '隐藏' });
                if (ok) visibility.mutate({ id: row.id, action: 'hide' });
              }}
            >
              隐藏
            </Button>
          ) : null}
          {row.status === 'HIDDEN' || row.status === 'DELETED' ? (
            <Button size="sm" variant="secondary" onClick={() => visibility.mutate({ id: row.id, action: 'restore' })}>
              恢复
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={row.isPinned ? 'ghost' : 'secondary'}
            onClick={() => pin.mutate({ id: row.id, pinned: !row.isPinned })}
          >
            {row.isPinned ? '取消置顶' : '置顶'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      {confirmNode}
      <PageHeader title="帖子" description="隐藏 / 恢复 / 置顶 / 排序。点行进入编辑。" />

      <div className="flex flex-wrap items-end gap-3">
        <Input
          placeholder="搜索标题"
          value={filters.q}
          aria-label="搜索帖子"
          className="max-w-xs"
          onChange={(event) => setFilters({ q: event.target.value })}
        />
        <div className="w-36">
          <Select
            aria-label="状态"
            value={filters.status}
            onChange={(value) => setFilters({ status: value })}
            options={[
              { value: 'ALL', label: '全部状态' },
              { value: 'PUBLISHED', label: '已发布' },
              { value: 'DRAFT', label: '草稿' },
              { value: 'HIDDEN', label: '隐藏' },
              { value: 'DELETED', label: '已删除' },
            ]}
          />
        </div>
        <div className="w-36">
          <Select
            aria-label="置顶"
            value={filters.pinned}
            onChange={(value) => setFilters({ pinned: value })}
            options={[
              { value: 'ALL', label: '全部' },
              { value: 'PINNED', label: '仅置顶' },
              { value: 'NORMAL', label: '非置顶' },
            ]}
          />
        </div>
        {isFiltered ? (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            清空筛选
          </Button>
        ) : null}
      </div>

      {pinned.length > 1 ? (
        <div className="rounded-lg border border-border-default bg-surface p-4">
          <p className="mb-2 text-sm font-medium">置顶顺序(数值越小越靠前)</p>
          <ol className="space-y-2">
            {pinned.map((row, index) => (
              <li key={row.id} className="flex items-center gap-2 text-sm">
                <span className="w-8 tabular text-fg-muted">#{row.pinnedOrder ?? index}</span>
                <span className="min-w-0 flex-1 truncate">{row.title}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => {
                    const next = pinned.map((item, i) => ({ postId: item.id, order: i }));
                    const swap = next[index - 1];
                    if (!swap) return;
                    next[index - 1] = next[index]!;
                    next[index] = swap;
                    reorder.mutate(next.map((item, i) => ({ ...item, order: i })));
                  }}
                >
                  上移
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={index === pinned.length - 1 || reorder.isPending}
                  onClick={() => {
                    const next = pinned.map((item, i) => ({ postId: item.id, order: i }));
                    const swap = next[index + 1];
                    if (!swap) return;
                    next[index + 1] = next[index]!;
                    next[index] = swap;
                    reorder.mutate(next.map((item, i) => ({ ...item, order: i })));
                  }}
                >
                  下移
                </Button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {listQuery.isError ? <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : null}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        emptyMessage="没有帖子"
        onRowClick={(row) => router.push(`/admin/posts/${row.id}`)}
      />
      <LoadMore
        hasMore={Boolean(listQuery.hasNextPage)}
        loading={listQuery.isFetchingNextPage}
        onLoadMore={() => void listQuery.fetchNextPage()}
      />
    </div>
  );
}
