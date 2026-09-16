'use client';

import { INHERITABLE_SHOP_FIELD_LABELS, type InheritableShopField } from '@june/shared';
import { KeyRound, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/utils';

import { useShopDetail, useShopMutations } from '../hooks/use-shops';
import { SHOP_TYPE_LABEL } from '../lib/format';

import { ShopDeleteDialog } from './shop-delete-dialog';
import { ShopForm } from './shop-form';

export function ShopDetailPage({ shopId }: { shopId: string }): React.JSX.Element {
  const router = useRouter();
  const detail = useShopDetail(shopId);
  const { resetInheritance } = useShopMutations();
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

  return (
    <div className="space-y-4">
      <PageHeader
        title={shop.name}
        description={`${SHOP_TYPE_LABEL[shop.type]}${shop.parentName ? ` · 主店 ${shop.parentName}` : ''}`}
        breadcrumbs={[{ label: '店铺', href: '/workbench/shops' }, { label: shop.name }]}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" iconLeft={<KeyRound size={16} />} asChild>
              <Link href={`/workbench/shops/${shop.id}/credentials`}>凭据</Link>
            </Button>
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
        <span className="text-sm text-fg-muted">商品 {shop.productCount}</span>
        <span className="text-sm text-fg-muted">子店 {shop.childCount}</span>
        <span className="text-sm text-fg-muted">凭据 {shop.credentialCount}</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h2">基本信息</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Info label="店铺链接" value={shop.url} />
          <Info label="简介" value={shop.description} />
          <Info label="创建时间" value={formatDateTime(shop.createdAt)} />
          <Info label="更新时间" value={formatDateTime(shop.updatedAt)} />
        </CardContent>
      </Card>

      {shop.type === 'SUB' ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">继承与覆盖</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {shop.inheritance.map((item) => {
              const field = item.field as InheritableShopField;
              const label = INHERITABLE_SHOP_FIELD_LABELS[field] ?? item.field;
              return (
                <div key={item.field} className="flex flex-col gap-2 rounded-md border border-border-default px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-fg">{label}</p>
                      <Badge tone={item.overridden ? 'warning' : 'accent'} size="sm">
                        {item.overridden ? '已覆盖' : '继承'}
                      </Badge>
                    </div>
                    <p className="text-sm text-fg-muted">当前：{item.value || '—'}</p>
                    {item.overridden ? (
                      <p className="text-xs text-fg-subtle">主店值：{item.inheritedValue || '—'}</p>
                    ) : (
                      <p className="text-xs text-fg-subtle">继承自主店</p>
                    )}
                  </div>
                  {item.overridden ? (
                    <Button
                      variant="outline"
                      size="sm"
                      loading={resetInheritance.isPending}
                      onClick={() => {
                        void resetInheritance
                          .mutateAsync({ id: shop.id, fields: [field] })
                          .then(() => toast.success(`已恢复「${label}」继承`))
                          .catch(() => toast.error('重置继承失败'));
                      }}
                    >
                      恢复继承
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle as="h2">可被子店继承的字段</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Info label="平台" value={shop.platform} />
            <Info label="联系人" value={shop.contactName} />
            <Info label="联系方式" value={shop.contactInfo} />
            <Info label="备注" value={shop.note} />
          </CardContent>
        </Card>
      )}

      <ShopDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        shopId={shop.id}
        shopName={shop.name}
        shopType={shop.type}
        childCount={shop.childCount}
        productCount={shop.productCount}
        credentialCount={shop.credentialCount}
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
