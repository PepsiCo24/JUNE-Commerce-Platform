'use client';

import type { ProductSummary } from '@june/shared';
import { Package, Plus, Search, Upload } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import type { Column } from '@/components/ui/table';
import { DataTable } from '@/components/ui/table';
import { formatDateTime, formatPrice } from '@/lib/utils';

import { useShopOptions } from '../hooks/use-options';
import { useProductList } from '../hooks/use-products';

export function ProductListPage(): React.JSX.Element {
  const shops = useShopOptions();
  const [q, setQ] = useState('');
  const [submittedQ, setSubmittedQ] = useState('');
  const [shopId, setShopId] = useState<string | null>(null);
  const [status, setStatus] = useState<'ALL' | 'DRAFT' | 'ACTIVE' | 'OFF_SHELF' | 'ARCHIVED'>('ALL');
  const list = useProductList({ q: submittedQ, shopId: shopId ?? undefined, status });

  const columns = useMemo<Array<Column<ProductSummary>>>(
    () => [
      {
        key: 'name',
        header: '商品',
        render: (row) => (
          <div>
            <Link href={`/workbench/products/${row.id}`} className="font-medium text-fg hover:text-accent">
              {row.name}
            </Link>
            {row.sku ? <p className="text-xs text-fg-subtle">{row.sku}</p> : null}
          </div>
        ),
      },
      {
        key: 'shop',
        header: '店铺',
        hideOnMobile: true,
        render: (row) => row.shopName,
      },
      {
        key: 'price',
        header: '价格',
        numeric: true,
        render: (row) => formatPrice(row.price, row.currency),
      },
      {
        key: 'stock',
        header: '库存',
        numeric: true,
        hideOnMobile: true,
        render: (row) => row.stock,
      },
      {
        key: 'status',
        header: '状态',
        render: (row) => <StatusBadge status={row.status} />,
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
        title="商品"
        description="维护商品资料,或通过 CSV 批量导入。"
        breadcrumbs={[{ label: '工作台', href: '/workbench' }, { label: '商品' }]}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" iconLeft={<Upload size={16} />} asChild>
              <Link href="/workbench/products/import">导入</Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/workbench/storage">存储用量</Link>
            </Button>
            <Button iconLeft={<Plus size={16} />} asChild>
              <Link href="/workbench/products/new">新建商品</Link>
            </Button>
          </div>
        }
      />

      <form
        className="flex flex-col gap-3 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmittedQ(q.trim());
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索名称或 SKU" className="pl-9" />
        </div>
        <Select
          aria-label="店铺"
          value={shopId ?? '__all__'}
          onChange={(value) => setShopId(value === '__all__' ? null : value)}
          options={[
            { value: '__all__', label: '全部店铺' },
            ...(shops.data ?? []).map((shop) => ({ value: shop.id, label: shop.name })),
          ]}
        />
        <Select
          aria-label="状态"
          value={status}
          onChange={(value) => setStatus(value as typeof status)}
          options={[
            { value: 'ALL', label: '全部状态' },
            { value: 'DRAFT', label: '草稿' },
            { value: 'ACTIVE', label: '在售' },
            { value: 'OFF_SHELF', label: '已下架' },
            { value: 'ARCHIVED', label: '已归档' },
          ]}
        />
        <Button type="submit">搜索</Button>
      </form>

      {list.isError ? (
        <ErrorState error={list.error} onRetry={list.refetch} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={list.items}
            rowKey={(row) => row.id}
            loading={list.isLoading}
            emptyMessage={<EmptyState icon={<Package size={22} />} title="还没有商品" />}
          />
          {!list.isLoading && list.items.length > 0 ? (
            <LoadMore hasMore={list.hasMore} loading={list.isFetchingNextPage} onLoadMore={list.loadMore} />
          ) : null}
        </>
      )}
    </div>
  );
}
