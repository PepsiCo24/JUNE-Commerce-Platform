'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';

import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AssetImage } from '@/components/media/asset-image';
import { formatDateTime, formatPrice } from '@/lib/utils';

import { useProductDetail } from '../hooks/use-products';

import { ProductForm } from './product-form';
import { useState } from 'react';

export function ProductDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const detail = useProductDetail(params.id);
  const [editing, setEditing] = useState(false);

  if (detail.isPending) return <LoadingState message="加载商品" />;
  if (detail.isError || !detail.data) {
    return <ErrorState error={detail.error ?? new Error('商品不存在')} onRetry={() => void detail.refetch()} />;
  }

  const product = detail.data;
  if (editing) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          返回详情
        </Button>
        <ProductForm product={product} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={product.name}
        description={product.sku ?? product.shopName}
        breadcrumbs={[{ label: '商品', href: '/workbench/products' }, { label: product.name }]}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" asChild>
              <Link href={`/workbench/copy?product=${product.id}`}>生成文案</Link>
            </Button>
            <Button onClick={() => setEditing(true)}>编辑</Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={product.status} />
        <span className="text-sm text-fg-muted">{product.shopName}</span>
        <span className="tabular text-sm text-fg">{formatPrice(product.price, product.currency)}</span>
        <span className="tabular text-sm text-fg-muted">库存 {product.stock}</span>
      </div>

      {product.images.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {product.images.map((image) => (
            <AssetImage
              key={image.assetId}
              asset={{ id: image.assetId, url: image.url, previewUrl: image.previewUrl, width: image.width, height: image.height }}
              variant="preview"
              alt={product.name}
              aspect="1/1"
              className="rounded-md"
            />
          ))}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle as="h2">资料</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {product.title ? <p className="font-medium text-fg">{product.title}</p> : null}
          <p className="whitespace-pre-wrap text-fg-muted">{product.description || '暂无描述'}</p>
          {Object.keys(product.attributes).length > 0 ? (
            <dl className="grid gap-2 sm:grid-cols-2">
              {Object.entries(product.attributes).map(([key, value]) => (
                <div key={key}>
                  <dt className="text-xs text-fg-subtle">{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <p className="text-xs text-fg-subtle">
            创建 {formatDateTime(product.createdAt)} · 更新 {formatDateTime(product.updatedAt)}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
