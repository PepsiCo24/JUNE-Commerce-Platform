'use client';

import { PAGE_SIZE_DEFAULT, type AdminUserSummary, type PageResult } from '@june/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { fieldErrorsOf, isErrorCode, toastApiError } from '@/features/admin/lib/errors';
import { describeRoles, formatBytes } from '@/features/admin/lib/format';
import { compactQuery, emptyPage } from '@/features/admin/lib/query';
import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';
import { PasswordInput } from '@/features/auth/password-input';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { q: '', status: 'ALL', role: 'admin', page: '1' };

export function AdminsScreen(): React.JSX.Element {
  const router = useRouter();
  const { user: actor } = useAdminAuth();
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);
  const [createOpen, setCreateOpen] = useState(false);
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
    mutationFn: (input: { id: string; status: 'ACTIVE' | 'DISABLED' }) =>
      adminApi.put(ADMIN_PATHS.users.status(input.id), { status: input.status }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminKeys.all }),
    onError: (error) => toastApiError(error, '无法更新管理员状态'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => adminApi.delete(ADMIN_PATHS.users.detail(id)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminKeys.all }),
    onError: (error) => toastApiError(error, '无法删除管理员'),
  });

  const pageData = listQuery.data ?? emptyPage<AdminUserSummary>();
  const lastSuperAdminError =
    isErrorCode(statusMutation.error, 'LAST_SUPER_ADMIN') || isErrorCode(deleteMutation.error, 'LAST_SUPER_ADMIN')
      ? '不能删除或禁用最后一个超级管理员'
      : null;

  const columns: Array<Column<AdminUserSummary>> = [
    {
      key: 'user',
      header: '账号',
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
      render: (row) => <Badge size="sm">{describeRoles(row.roles)}</Badge>,
    },
    { key: 'storage', header: '存储', numeric: true, hideOnMobile: true, render: (row) => formatBytes(row.storageBytes) },
    { key: 'active', header: '最近活跃', hideOnMobile: true, render: (row) => formatDateTime(row.lastActiveAt) },
    {
      key: 'actions',
      header: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1" onClick={(event) => event.stopPropagation()}>
          <Button
            variant={row.status === 'ACTIVE' ? 'danger' : 'secondary'}
            size="sm"
            disabled={statusMutation.isPending || row.id === actor?.id}
            onClick={async () => {
              const next = row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
              const ok = await confirm({
                title: next === 'DISABLED' ? '禁用该管理员?' : '重新启用该管理员?',
                description:
                  next === 'DISABLED'
                    ? '禁用会立即作废该账号全部管理站会话。最后一个超级管理员不能被禁用。'
                    : '启用后可重新登录管理站。',
                danger: next === 'DISABLED',
                requireText: next === 'DISABLED' ? row.email : undefined,
                confirmLabel: next === 'DISABLED' ? '禁用' : '启用',
              });
              if (ok) statusMutation.mutate({ id: row.id, status: next });
            }}
          >
            {row.status === 'ACTIVE' ? '禁用' : '启用'}
          </Button>
          {actor?.isSuperAdmin ? (
            <Button
              variant="danger"
              size="sm"
              disabled={deleteMutation.isPending || row.id === actor.id}
              onClick={async () => {
                const ok = await confirm({
                  title: '删除该管理员?',
                  description: '软删除。最后一个超级管理员不能被删除。',
                  danger: true,
                  requireText: row.email,
                  confirmLabel: '删除',
                });
                if (ok) deleteMutation.mutate(row.id);
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
      <PageHeader
        title="管理员账号"
        description="列表按角色筛选。首个超管用 pnpm admin:init;后续可由超管在此创建。"
        actions={
          actor?.isSuperAdmin ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              创建管理员
            </Button>
          ) : null
        }
      />

      {lastSuperAdminError ? (
        <p className="rounded-md border border-state-danger-border bg-state-danger-bg px-3 py-2 text-sm text-state-danger-fg">
          {lastSuperAdminError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <Input
          placeholder="搜索邮箱或昵称"
          value={filters.q}
          onChange={(event) => setFilters({ q: event.target.value, page: '1' })}
          aria-label="搜索管理员"
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
        <div className="w-44">
          <Select
            aria-label="角色"
            value={filters.role}
            onChange={(value) => setFilters({ role: value, page: '1' })}
            options={[
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
        emptyMessage="没有符合条件的管理员"
        onRowClick={(row) => router.push(`/admin/users/${row.id}`)}
      />

      <Pagination
        page={pageData.page}
        pageSize={pageData.pageSize}
        total={pageData.total}
        onPageChange={(next) => setFilters({ page: String(next) })}
      />

      {createOpen ? (
        <CreateAdminDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void queryClient.invalidateQueries({ queryKey: adminKeys.all });
          }}
        />
      ) : null}
    </div>
  );
}

function CreateAdminDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'super_admin'>('admin');

  const create = useMutation({
    mutationFn: () =>
      adminApi.post<AdminUserSummary>(ADMIN_PATHS.users.create, {
        email,
        displayName,
        password,
        role,
      }),
    onSuccess: (user) => {
      toast.success('管理员已创建', { description: user.email });
      onCreated();
    },
    onError: (error) => toastApiError(error, '无法创建管理员'),
  });

  const errors = fieldErrorsOf(create.error);

  return (
    <Dialog
      open
      theme="light"
      title="创建管理员"
      description="密码不会回显到列表或审计明文。邮箱已存在时请改用用户详情授予角色。"
      onOpenChange={(open) => !open && onClose()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            取消
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !email || !displayName || !password}
          >
            {create.isPending ? '创建中…' : '创建'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm text-fg-muted">邮箱</span>
          <Input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            invalid={Boolean(errors.email)}
            aria-invalid={Boolean(errors.email)}
          />
          {errors.email ? <span className="text-xs text-state-danger-fg">{errors.email}</span> : null}
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm text-fg-muted">显示名</span>
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            invalid={Boolean(errors.displayName)}
            aria-invalid={Boolean(errors.displayName)}
          />
          {errors.displayName ? (
            <span className="text-xs text-state-danger-fg">{errors.displayName}</span>
          ) : null}
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm text-fg-muted">初始密码</span>
          <PasswordInput
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            invalid={Boolean(errors.password)}
          />
          {errors.password ? (
            <span className="text-xs text-state-danger-fg">{errors.password}</span>
          ) : (
            <span className="text-xs text-fg-subtle">至少 10 位,且含大小写、数字、符号中的至少三类</span>
          )}
        </label>
        <div className="space-y-1.5">
          <span className="text-sm text-fg-muted">角色</span>
          <Select
            aria-label="角色"
            value={role}
            onChange={(value) => setRole(value as 'admin' | 'super_admin')}
            options={[
              { value: 'admin', label: '管理员' },
              { value: 'super_admin', label: '超级管理员' },
            ]}
          />
        </div>
      </div>
    </Dialog>
  );
}
