'use client';

import { Package, Plus, Search, Upload } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import type { Column } from '@/components/ui/table';
import { DataTable } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/badge';
import { formatDateTime, formatPrice } from '@/lib/utils';
import type { ProductSummary } from '@june/shared';

import { useShopDetail } from '../hooks/use-shops';
import { useProductList } from '../hooks/use-products';

export function ShopProductListPage({ shopId }: { shopId: string }): React.JSX.Element {
  const shop = useShopDetail(shopId);
  const [q, setQ] = useState('');
  const [submittedQ, setSubmittedQ] = useState('');
  const [status, setStatus] = useState<'ALL' | 'DRAFT' | 'ACTIVE' | 'OFF_SHELF' | 'ARCHIVED'>('ALL');
  const list = useProductList({ q: submittedQ, shopId, status });

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
        key: 'price',
        header: '价格',
        numeric: true,
        render: (row) => formatPrice(row.price, row.currency),
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

  if (shop.isPending) return <LoadingState message="加载店铺" />;
  if (shop.isError || !shop.data) {
    return <ErrorState error={shop.error ?? new Error('店铺不存在')} onRetry={() => void shop.refetch()} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${shop.data.name} · 商品`}
        description="管理本店商品。上传、导入与编辑均在此店铺范围内。"
        breadcrumbs={[
          { label: '店铺', href: '/workbench/shops' },
          { label: shop.data.name, href: `/workbench/shops/${shopId}` },
          { label: '商品' },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" iconLeft={<Upload size={16} />} asChild>
              <Link href={`/workbench/products/import?shopId=${shopId}`}>导入</Link>
            </Button>
            <Button iconLeft={<Plus size={16} />} asChild>
              <Link href={`/workbench/products/new?shopId=${shopId}`}>新建商品</Link>
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
          <Input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="搜索商品名称或 SKU"
            className="pl-9"
            aria-label="搜索商品"
          />
        </div>
        <Select
          aria-label="商品状态"
          value={status}
          onChange={(value) => setStatus(value as typeof status)}
          options={[
            { value: 'ALL', label: '全部状态' },
            { value: 'ACTIVE', label: '在售' },
            { value: 'DRAFT', label: '草稿' },
            { value: 'OFF_SHELF', label: '下架' },
            { value: 'ARCHIVED', label: '归档' },
          ]}
        />
        <Button type="submit">搜索</Button>
      </form>

      {list.isError ? <ErrorState error={list.error} onRetry={list.refetch} /> : null}
      <DataTable
        columns={columns}
        rows={list.items}
        rowKey={(row) => row.id}
        loading={list.isLoading}
        emptyMessage={
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-fg-muted">
            <Package size={22} aria-hidden />
            <p>本店还没有商品</p>
            <Button size="sm" asChild>
              <Link href={`/workbench/products/new?shopId=${shopId}`}>添加第一件商品</Link>
            </Button>
          </div>
        }
      />
      {!list.isLoading && list.items.length > 0 ? (
        <LoadMore hasMore={list.hasMore} loading={list.isFetchingNextPage} onLoadMore={list.loadMore} />
      ) : null}
    </div>
  );
}
