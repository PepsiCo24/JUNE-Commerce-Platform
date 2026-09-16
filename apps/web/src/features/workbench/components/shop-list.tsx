'use client';

import { PAGE_SIZE_DEFAULT, type ShopSummary } from '@june/shared';
import { Plus, Search, Store } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import type { Column } from '@/components/ui/table';
import { DataTable } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

import { useShopList, useShopStats } from '../hooks/use-shops';
import { SHOP_TYPE_LABEL } from '../lib/format';

export function ShopListPage(): React.JSX.Element {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [submittedQ, setSubmittedQ] = useState('');
  const [type, setType] = useState<'ALL' | 'MAIN' | 'SUB'>('ALL');
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'PAUSED' | 'CLOSED'>('ALL');

  const list = useShopList({ page, pageSize: PAGE_SIZE_DEFAULT, q: submittedQ, type, status });
  const stats = useShopStats();

  const columns = useMemo<Array<Column<ShopSummary>>>(
    () => [
      {
        key: 'name',
        header: '店铺',
        render: (row) => (
          <div>
            <Link href={`/workbench/shops/${row.id}`} className="font-medium text-fg hover:text-accent">
              {row.name}
            </Link>
            {row.parentName ? <p className="text-xs text-fg-subtle">主店 {row.parentName}</p> : null}
          </div>
        ),
      },
      {
        key: 'type',
        header: '类型',
        render: (row) => <Badge tone={row.type === 'MAIN' ? 'accent' : 'purple'}>{SHOP_TYPE_LABEL[row.type]}</Badge>,
      },
      {
        key: 'status',
        header: '状态',
        render: (row) => <StatusBadge status={row.status} />,
      },
      {
        key: 'platform',
        header: '平台',
        hideOnMobile: true,
        render: (row) => row.platform ?? '—',
      },
      {
        key: 'products',
        header: '商品',
        numeric: true,
        render: (row) => row.productCount,
      },
      {
        key: 'children',
        header: '子店',
        numeric: true,
        hideOnMobile: true,
        render: (row) => row.childCount,
      },
      {
        key: 'updatedAt',
        header: '更新',
        hideOnMobile: true,
        render: (row) => formatDateTime(row.updatedAt),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="店铺"
        description="管理主店与子店。子店默认继承平台、联系人与备注。"
        breadcrumbs={[{ label: '工作台', href: '/workbench' }, { label: '店铺' }]}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" asChild>
              <Link href="/workbench/shops/graph">关系图</Link>
            </Button>
            <Button iconLeft={<Plus size={16} />} asChild>
              <Link href="/workbench/shops/new">新建店铺</Link>
            </Button>
          </div>
        }
      />

      {stats.data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="店铺总数" value={stats.data.total} />
          <StatCard label="主店" value={stats.data.mainCount} />
          <StatCard label="子店" value={stats.data.subCount} />
          <StatCard
            label="商品合计"
            value={stats.data.productCountByShop.reduce((sum, item) => sum + item.productCount, 0)}
          />
        </div>
      ) : null}

      {stats.data && stats.data.productCountByShop.length > 0 ? (
        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-sm font-medium text-fg">每店商品数</p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {stats.data.productCountByShop.map((item) => (
                <li key={item.shopId} className="flex justify-between text-sm text-fg-muted">
                  <Link href={`/workbench/shops/${item.shopId}`} className="hover:text-accent">
                    {item.shopName}
                  </Link>
                  <span className="tabular">{item.productCount}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <form
        className="flex flex-col gap-3 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setSubmittedQ(q.trim());
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="搜索店铺名称"
            className="pl-9"
            aria-label="搜索店铺"
          />
        </div>
        <Select
          aria-label="店铺类型"
          value={type}
          onChange={(value) => {
            setType(value as 'ALL' | 'MAIN' | 'SUB');
            setPage(1);
          }}
          options={[
            { value: 'ALL', label: '全部类型' },
            { value: 'MAIN', label: '主店' },
            { value: 'SUB', label: '子店' },
          ]}
        />
        <Select
          aria-label="店铺状态"
          value={status}
          onChange={(value) => {
            setStatus(value as 'ALL' | 'ACTIVE' | 'PAUSED' | 'CLOSED');
            setPage(1);
          }}
          options={[
            { value: 'ALL', label: '全部状态' },
            { value: 'ACTIVE', label: '启用' },
            { value: 'PAUSED', label: '暂停' },
            { value: 'CLOSED', label: '关闭' },
          ]}
        />
        <Button type="submit">搜索</Button>
      </form>

      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={list.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={list.isPending}
            emptyMessage={<EmptyState icon={<Store size={22} />} title="还没有店铺" description="先创建一家主店,再按需添加子店。" />}
            onRowClick={(row) => router.push(`/workbench/shops/${row.id}`)}
          />
          {list.data ? (
            <Pagination
              page={list.data.page}
              pageSize={list.data.pageSize}
              total={list.data.total}
              onPageChange={setPage}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-fg-muted">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular text-fg">{value}</p>
      </CardContent>
    </Card>
  );
}
