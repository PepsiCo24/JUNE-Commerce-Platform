'use client';

import { TARGET_PLATFORMS } from '@june/shared';
import { Package, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { useShopDetail } from '../hooks/use-shops';
import { SHOP_TYPE_LABEL } from '../lib/format';

import { ShopDeleteDialog } from './shop-delete-dialog';
import { ShopForm } from './shop-form';

export function ShopDetailPage({ shopId }: { shopId: string }): React.JSX.Element {
  const router = useRouter();
  const detail = useShopDetail(shopId);
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (detail.isPending) return <LoadingState message="加载店铺" />;
  if (detail.isError || !detail.data) {
    return <ErrorState error={detail.error ?? new Error('店铺不存在')} onRetry={() => void detail.refetch()} />;
  }

  const shop = detail.data;

  if (editing) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          返回详情
        </Button>
        <ShopForm shop={shop} />
      </div>
    );
  }

  const platformLabel =
    TARGET_PLATFORMS.find((item) => item.value === shop.platform)?.label ?? shop.platform;
  const alipayLabel = shop.alipayAccount
    ? `${shop.alipayAccount.name} · ${shop.alipayAccount.phoneMasked}`
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={shop.name}
        description={`${SHOP_TYPE_LABEL[shop.type]}${shop.parentName ? ` · 主店 ${shop.parentName}` : ''}`}
        breadcrumbs={[{ label: '店铺', href: '/workbench/shops' }, { label: shop.name }]}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" iconLeft={<Pencil size={16} />} onClick={() => setEditing(true)}>
              编辑
            </Button>
            <Button variant="danger" iconLeft={<Trash2 size={16} />} onClick={() => setDeleteOpen(true)}>
              删除
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap gap-2">
        <StatusBadge status={shop.status} />
        <Badge>{SHOP_TYPE_LABEL[shop.type]}</Badge>
        <span className="text-sm text-fg-muted">直属商品 {shop.productCount}</span>
        {shop.childCount > 0 ? (
          <span className="text-sm text-fg-muted">含子店 {shop.totalProductCount}</span>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h2">店铺信息</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Info label="店铺属性" value={SHOP_TYPE_LABEL[shop.type]} />
          <Info label="店铺名称" value={shop.name} />
          <Info label="店铺平台" value={platformLabel} />
          <Info label="店铺账号" value={shop.platformAccount} />
          <Info label="密码" value={shop.hasPrimaryPassword ? '已设置' : '未设置'} />
          <Info label="绑定支付宝账户" value={alipayLabel} />
          <Info label="手机号" value={shop.phone ?? shop.contactInfo} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle as="h2" className="flex items-center gap-2">
            <Package size={18} aria-hidden />
            本店商品
          </CardTitle>
          <Button variant="secondary" size="sm" asChild>
            <Link href={`/workbench/shops/${shop.id}/products`}>查看本店商品</Link>
          </Button>
        </CardHeader>
        <CardContent className="text-sm text-fg-muted">
          当前直属商品 {shop.productCount} 件
          {shop.childCount > 0 ? `，含子店合计 ${shop.totalProductCount} 件` : ''}。
        </CardContent>
      </Card>

      <ShopDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        shopId={shop.id}
        shopName={shop.name}
        shopType={shop.type}
        childCount={shop.childCount}
        productCount={shop.productCount}
        onDeleted={() => router.push('/workbench/shops')}
      />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null | undefined }): React.JSX.Element {
  return (
    <div>
      <p className="text-xs text-fg-subtle">{label}</p>
      <p className="text-sm text-fg">{value || '—'}</p>
    </div>
  );
}
