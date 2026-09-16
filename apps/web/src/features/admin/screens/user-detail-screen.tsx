'use client';

import { PAGE_SIZE_DEFAULT } from '@june/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type {
  AdminProductSummaryView,
  AdminShopDetailView,
  AdminUserDetailView,
} from '@/features/admin/api/types';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { isErrorCode, toastApiError } from '@/features/admin/lib/errors';
import { describeRoles, formatBytes, formatInteger } from '@/features/admin/lib/format';
import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/toggle';
import { LoadMore } from '@/components/ui/pagination';
import { DataTable, type Column } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

const ROLE_OPTIONS = [
  { value: 'user', label: '普通用户' },
  { value: 'admin', label: '管理员' },
  { value: 'super_admin', label: '超级管理员' },
] as const;

export function UserDetailScreen({ userId }: { userId: string }): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user: actor } = useAdminAuth();
  const { confirm, confirmNode } = useActionConfirm();
  const [openShopId, setOpenShopId] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[] | null>(null);

  const detailQuery = useQuery({
    queryKey: adminKeys.user(userId),
    queryFn: ({ signal }) => adminApi.get<AdminUserDetailView>(ADMIN_PATHS.users.detail(userId), { signal }),
  });

  const shopsQuery = useInfiniteQuery({
    queryKey: adminKeys.userShops(userId),
    queryFn: ({ pageParam, signal }) =>
      adminApi.get<{ items: AdminShopDetailView[]; nextCursor: string | null; hasMore: boolean }>(
        ADMIN_PATHS.users.shops(userId),
        { signal, query: { cursor: pageParam, limit: PAGE_SIZE_DEFAULT } },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const productsQuery = useInfiniteQuery({
    queryKey: adminKeys.userShopProducts(userId, openShopId ?? ''),
    queryFn: ({ pageParam, signal }) =>
      adminApi.get<{ items: AdminProductSummaryView[]; nextCursor: string | null; hasMore: boolean }>(
        ADMIN_PATHS.users.shopProducts(userId, openShopId!),
        { signal, query: { cursor: pageParam, limit: PAGE_SIZE_DEFAULT } },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(openShopId),
  });

  const statusMutation = useMutation({
    mutationFn: (input: { status: 'ACTIVE' | 'DISABLED' }) =>
      adminApi.put(ADMIN_PATHS.users.status(userId), input),
    onSuccess: () => {
      toast.success('已更新状态');
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
    onError: (error) => toastApiError(error, '无法更新用户状态'),
  });

  const rolesMutation = useMutation({
    mutationFn: (nextRoles: string[]) => adminApi.put(ADMIN_PATHS.users.roles(userId), { roles: nextRoles }),
    onSuccess: () => {
      toast.success('已更新角色');
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
    onError: (error) => toastApiError(error, '无法更新角色'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => adminApi.delete(ADMIN_PATHS.users.detail(userId)),
    onSuccess: () => {
      toast.success('已删除用户');
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
      router.push('/admin/users');
    },
    onError: (error) => toastApiError(error, '无法删除用户'),
  });

  if (detailQuery.isPending) return <LoadingState message="加载用户" />;
  if (detailQuery.isError) return <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />;

  const user = detailQuery.data;
  const shops = shopsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const products = productsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedRoles = roles ?? user.roles;
  const lastSuperAdminError =
    isErrorCode(rolesMutation.error, 'LAST_SUPER_ADMIN') || isErrorCode(deleteMutation.error, 'LAST_SUPER_ADMIN')
      ? '不能删除或禁用最后一个超级管理员'
      : null;

  const shopColumns: Array<Column<AdminShopDetailView>> = [
    {
      key: 'name',
      header: '店铺',
      render: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-fg-muted">{row.platform ?? '未填平台'}</p>
        </div>
      ),
    },
    {
      key: 'type',
      header: '主 / 子',
      render: (row) => (
        <div>
          <Badge size="sm">{row.type === 'MAIN' ? '主店' : '子店'}</Badge>
          {row.parentName ? <p className="mt-1 text-xs text-fg-muted">上级 {row.parentName}</p> : null}
        </div>
      ),
    },
    { key: 'status', header: '状态', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'products', header: '商品', numeric: true, render: (row) => row.productCount },
    { key: 'children', header: '子店', numeric: true, hideOnMobile: true, render: (row) => row.childCount },
    {
      key: 'credentials',
      header: '凭据',
      render: (row) => (
        <div className="space-y-1 text-xs text-fg-muted">
          {row.credentials.length === 0
            ? '无'
            : row.credentials.map((item) => (
                <p key={item.id}>
                  {item.purpose} · {item.account}
                  {item.loginUrl ? ` · ${item.loginUrl}` : ''}
                  {item.note ? ` · ${item.note}` : ''}
                </p>
              ))}
        </div>
      ),
    },
  ];

  const productColumns: Array<Column<AdminProductSummaryView>> = [
    { key: 'name', header: '商品', render: (row) => row.name },
    { key: 'sku', header: 'SKU', hideOnMobile: true, render: (row) => row.sku ?? '—' },
    { key: 'status', header: '状态', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'price',
      header: '价格',
      numeric: true,
      render: (row) => (row.price ? `${row.price} ${row.currency}` : '—'),
    },
    { key: 'stock', header: '库存', numeric: true, hideOnMobile: true, render: (row) => row.stock },
  ];

  return (
    <div className="space-y-6">
      {confirmNode}
      <PageHeader
        title={user.displayName}
        description={user.email}
        breadcrumbs={[
          { label: '用户', href: '/admin/users' },
          { label: user.displayName },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant={user.status === 'ACTIVE' ? 'danger' : 'secondary'}
              size="sm"
              disabled={user.id === actor?.id || statusMutation.isPending}
              onClick={async () => {
                const next = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
                const ok = await confirm({
                  title: next === 'DISABLED' ? '禁用该用户?' : '重新启用该用户?',
                  description:
                    next === 'DISABLED'
                      ? '禁用会立即作废该用户全部会话。最后一个超级管理员不能被禁用。'
                      : '启用后用户可重新登录。',
                  danger: next === 'DISABLED',
                  requireText: next === 'DISABLED' ? user.email : undefined,
                  confirmLabel: next === 'DISABLED' ? '禁用' : '启用',
                });
                if (ok) statusMutation.mutate({ status: next });
              }}
            >
              {user.status === 'ACTIVE' ? '禁用' : '启用'}
            </Button>
            {actor?.isSuperAdmin ? (
              <Button
                variant="danger"
                size="sm"
                disabled={user.id === actor.id || deleteMutation.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: '删除该用户?',
                    description: '软删除。最后一个超级管理员不能被删除。',
                    danger: true,
                    requireText: user.email,
                    confirmLabel: '删除',
                  });
                  if (ok) deleteMutation.mutate();
                }}
              >
                删除
              </Button>
            ) : null}
          </div>
        }
      />

      {lastSuperAdminError ? (
        <p className="rounded-md border border-state-danger-border bg-state-danger-bg px-3 py-2 text-sm text-state-danger-fg">
          {lastSuperAdminError}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Info label="状态" value={<StatusBadge status={user.status} />} />
        <Info label="角色" value={describeRoles(user.roles)} />
        <Info
          label="会话"
          value={`活跃 ${formatInteger(user.activeSessionCount)} / 累计 ${formatInteger(user.totalSessionCount)}`}
        />
        <Info
          label="存储"
          value={`${formatBytes(user.storageBytes)} / ${formatBytes(user.storageQuotaBytes)} (${user.storageUsedPercent}%)`}
        />
        <Info label="店铺" value={`主店 ${user.shopStats.main} · 子店 ${user.shopStats.sub}`} />
        <Info label="商品" value={formatInteger(user.productStats.total)} />
        <Info label="帖子" value={formatInteger(user.postStats.total)} />
        <Info label="最近登录" value={formatDateTime(user.lastLoginAt)} />
      </div>

      {actor?.isSuperAdmin ? (
        <section className="space-y-3 rounded-lg border border-border-default bg-surface p-4">
          <h2 className="text-base font-semibold">角色</h2>
          <p className="text-xs text-fg-muted">覆盖式设置。最后一个超级管理员不能被撤销。</p>
          <div className="flex flex-wrap gap-4">
            {ROLE_OPTIONS.map((option) => (
              <Checkbox
                key={option.value}
                label={option.label}
                checked={selectedRoles.includes(option.value)}
                onChange={(checked) => {
                  setRoles(
                    checked
                      ? Array.from(new Set([...selectedRoles, option.value]))
                      : selectedRoles.filter((role) => role !== option.value),
                  );
                }}
              />
            ))}
          </div>
          <Button
            size="sm"
            loading={rolesMutation.isPending}
            disabled={selectedRoles.length === 0}
            onClick={() => rolesMutation.mutate(selectedRoles)}
          >
            保存角色
          </Button>
        </section>
      ) : null}

      <div className="flex items-start gap-3 rounded-lg border border-state-warning-border bg-state-warning-bg p-4 text-sm text-state-warning-fg">
        <ShieldOff size={18} className="mt-0.5 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">不能查看店铺密码</p>
          <p className="mt-1 text-xs opacity-90">
            凭据只展示用途、账号、登录地址与备注。密码字段在类型与响应中均不存在。
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">店铺(含主子关系)</h2>
        {shopsQuery.isError ? <ErrorState error={shopsQuery.error} onRetry={() => void shopsQuery.refetch()} /> : null}
        <DataTable
          columns={shopColumns}
          rows={shops}
          rowKey={(row) => row.id}
          loading={shopsQuery.isPending}
          emptyMessage="该用户没有店铺"
          onRowClick={(row) => setOpenShopId(row.id)}
        />
        <LoadMore
          hasMore={Boolean(shopsQuery.hasNextPage)}
          loading={shopsQuery.isFetchingNextPage}
          onLoadMore={() => void shopsQuery.fetchNextPage()}
        />
      </section>

      {openShopId ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">商品下钻</h2>
            <button type="button" className="text-xs text-accent hover:underline" onClick={() => setOpenShopId(null)}>
              收起
            </button>
          </div>
          {productsQuery.isError ? (
            <ErrorState error={productsQuery.error} onRetry={() => void productsQuery.refetch()} />
          ) : null}
          <DataTable
            columns={productColumns}
            rows={products}
            rowKey={(row) => row.id}
            loading={productsQuery.isPending}
            emptyMessage="该店铺没有商品"
          />
          <LoadMore
            hasMore={Boolean(productsQuery.hasNextPage)}
            loading={productsQuery.isFetchingNextPage}
            onLoadMore={() => void productsQuery.fetchNextPage()}
          />
        </section>
      ) : (
        <p className="text-sm text-fg-muted">点击店铺行可下钻该店商品。</p>
      )}

      <p className="text-xs text-fg-subtle">
        <Link href={`/admin/posts?authorId=${user.id}`} className="text-accent hover:underline">
          查看该用户帖子
        </Link>
      </p>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-default bg-surface p-4">
      <p className="text-xs text-fg-muted">{label}</p>
      <div className="mt-1 text-sm font-medium text-fg">{value}</div>
    </div>
  );
}
