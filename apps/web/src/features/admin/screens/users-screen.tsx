'use client';

import type { AdminUserSummary, PageResult } from '@june/shared';
import { PAGE_SIZE_DEFAULT } from '@june/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';
import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { toastApiError } from '@/features/admin/lib/errors';
import { describeRoles, formatBytes } from '@/features/admin/lib/format';
import { compactQuery, emptyPage } from '@/features/admin/lib/query';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { q: '', status: 'ALL', role: 'ALL', page: '1' };

export function UsersScreen(): React.JSX.Element {
  const router = useRouter();
  const { user: actor } = useAdminAuth();
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);
  const page = Math.max(1, Number(filters.page) || 1);

  const params = compactQuery({
    q: filters.q,
    status: filters.status,
    role: filters.role,
    page,
    pageSize: PAGE_SIZE_DEFAULT,
  });

  const listQuery = useQuery({
    queryKey: adminKeys.users(params),
    queryFn: ({ signal }) =>
      adminApi.get<PageResult<AdminUserSummary>>(ADMIN_PATHS.users.list, { signal, query: params }),
  });

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: 'ACTIVE' | 'DISABLED'; reason?: string }) =>
      adminApi.put(ADMIN_PATHS.users.status(input.id), { status: input.status, reason: input.reason }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminKeys.all }),
    onError: (error) => toastApiError(error, '无法更新用户状态'),
  });

  const pageData = listQuery.data ?? emptyPage<AdminUserSummary>();

  const columns: Array<Column<AdminUserSummary>> = [
    {
      key: 'user',
      header: '用户',
      render: (row) => (
        <div>
          <p className="font-medium text-fg">{row.displayName}</p>
          <p className="text-xs text-fg-muted">{row.email}</p>
        </div>
      ),
    },
    { key: 'status', header: '状态', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'roles',
      header: '角色',
      hideOnMobile: true,
      render: (row) => <Badge size="sm">{describeRoles(row.roles)}</Badge>,
    },
    { key: 'shops', header: '店铺', numeric: true, hideOnMobile: true, render: (row) => row.shopCount },
    { key: 'products', header: '商品', numeric: true, hideOnMobile: true, render: (row) => row.productCount },
    { key: 'storage', header: '存储', numeric: true, hideOnMobile: true, render: (row) => formatBytes(row.storageBytes) },
    { key: 'active', header: '最近活跃', hideOnMobile: true, render: (row) => formatDateTime(row.lastActiveAt) },
    {
      key: 'actions',
      header: '操作',
      render: (row) => (
        <Button
          variant={row.status === 'ACTIVE' ? 'danger' : 'secondary'}
          size="sm"
          disabled={statusMutation.isPending || row.id === actor?.id}
          onClick={async (event) => {
            event.stopPropagation();
            const next = row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
            const ok = await confirm({
              title: next === 'DISABLED' ? '禁用该用户?' : '重新启用该用户?',
              description:
                next === 'DISABLED'
                  ? '禁用会立即作废该用户全部会话。最后一个超级管理员不能被禁用。'
                  : '启用后用户可重新登录。',
              danger: next === 'DISABLED',
              requireText: next === 'DISABLED' ? row.email : undefined,
              confirmLabel: next === 'DISABLED' ? '禁用' : '启用',
            });
            if (!ok) return;
            statusMutation.mutate({ id: row.id, status: next });
          }}
        >
          {row.status === 'ACTIVE' ? '禁用' : '启用'}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      {confirmNode}
      <PageHeader title="用户" description="搜索、分页、启用 / 禁用。点行进入详情,可下钻店铺与商品。" />

      <div className="flex flex-wrap items-end gap-3">
        <Input
          placeholder="搜索邮箱或昵称"
          value={filters.q}
          onChange={(event) => setFilters({ q: event.target.value, page: '1' })}
          aria-label="搜索用户"
          className="max-w-xs"
        />
        <div className="w-36">
          <Select
            aria-label="状态"
            value={filters.status}
            onChange={(value) => setFilters({ status: value, page: '1' })}
            options={[
              { value: 'ALL', label: '全部状态' },
              { value: 'ACTIVE', label: '启用' },
              { value: 'DISABLED', label: '禁用' },
            ]}
          />
        </div>
        <div className="w-40">
          <Select
            aria-label="角色"
            value={filters.role}
            onChange={(value) => setFilters({ role: value, page: '1' })}
            options={[
              { value: 'ALL', label: '全部角色' },
              { value: 'user', label: '普通用户' },
              { value: 'admin', label: '管理员' },
              { value: 'super_admin', label: '超级管理员' },
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
        rows={pageData.items}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        emptyMessage="没有符合条件的用户"
        onRowClick={(row) => router.push(`/admin/users/${row.id}`)}
      />

      <Pagination
        page={pageData.page}
        pageSize={pageData.pageSize}
        total={pageData.total}
        onPageChange={(next) => setFilters({ page: String(next) })}
      />
    </div>
  );
}
