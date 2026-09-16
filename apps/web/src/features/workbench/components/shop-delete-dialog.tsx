'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api/errors';

import { useShopOptions } from '../hooks/use-options';
import { SHOP_ERROR_COPY, describeWithOverrides } from '../lib/error-copy';
import { useShopMutations } from '../hooks/use-shops';

type ChildrenStrategy = 'reject' | 'promote_to_main' | 'move_to_shop' | 'delete';
type ProductsStrategy = 'reject' | 'move_to_shop' | 'archive' | 'delete';
type CredentialsStrategy = 'reject' | 'delete';

export function ShopDeleteDialog({
  open,
  onOpenChange,
  shopId,
  shopName,
  shopType,
  childCount,
  productCount,
  credentialCount,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string;
  shopName: string;
  shopType: 'MAIN' | 'SUB';
  childCount: number;
  productCount: number;
  credentialCount: number;
  onDeleted?: () => void;
}): React.JSX.Element {
  const { remove } = useShopMutations();
  const shopsQuery = useShopOptions();
  const [confirmName, setConfirmName] = useState('');
  const [childrenStrategy, setChildrenStrategy] = useState<ChildrenStrategy>('reject');
  const [childrenTargetShopId, setChildrenTargetShopId] = useState<string | null>(null);
  const [productsStrategy, setProductsStrategy] = useState<ProductsStrategy>('reject');
  const [productsTargetShopId, setProductsTargetShopId] = useState<string | null>(null);
  const [credentialsStrategy, setCredentialsStrategy] = useState<CredentialsStrategy>('reject');

  const otherMains = useMemo(
    () =>
      (shopsQuery.data ?? [])
        .filter((shop) => shop.type === 'MAIN' && shop.id !== shopId)
        .map((shop) => ({ value: shop.id, label: shop.name })),
    [shopsQuery.data, shopId],
  );

  const isMain = shopType === 'MAIN';
  const needsChildrenChoice = isMain && childCount > 0;

  async function submit(): Promise<void> {
    try {
      const result = await remove.mutateAsync({
        id: shopId,
        body: {
          childrenStrategy: needsChildrenChoice ? childrenStrategy : 'reject',
          childrenTargetShopId: childrenStrategy === 'move_to_shop' ? (childrenTargetShopId ?? undefined) : undefined,
          productsStrategy: productCount > 0 ? productsStrategy : 'reject',
          productsTargetShopId: productsStrategy === 'move_to_shop' ? (productsTargetShopId ?? undefined) : undefined,
          credentialsStrategy: credentialCount > 0 ? credentialsStrategy : 'reject',
          confirmName,
        },
      });
      toast.success(
        `已删除店铺。子店 ${result.childrenAffected}、商品 ${result.productsAffected}、凭据 ${result.credentialsAffected}`,
      );
      onOpenChange(false);
      onDeleted?.();
    } catch (error) {
      toast.error(describeWithOverrides(error, SHOP_ERROR_COPY) || describeError(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setConfirmName('');
        onOpenChange(next);
      }}
      theme="dark"
      size="lg"
      title="删除店铺"
      description="删除不可撤销。主店下的子店、商品与凭据必须显式选择处理方式,不会静默级联删除。"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            disabled={confirmName !== shopName}
            onClick={() => void submit()}
          >
            确认删除
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          当前店铺「{shopName}」：子店 {childCount}、商品 {productCount}、凭据 {credentialCount}。
        </p>

        {needsChildrenChoice ? (
          <Field label="子店铺如何处理" htmlFor="children-strategy" required>
            <Select
              id="children-strategy"
              value={childrenStrategy}
              onChange={(value) => setChildrenStrategy(value as ChildrenStrategy)}
              options={[
                { value: 'reject', label: '若仍有子店则拒绝删除' },
                { value: 'promote_to_main', label: '将子店升为主店' },
                { value: 'move_to_shop', label: '迁移到另一家主店' },
                { value: 'delete', label: '同时删除空子店' },
              ]}
            />
          </Field>
        ) : null}

        {needsChildrenChoice && childrenStrategy === 'move_to_shop' ? (
          <Field label="子店迁往" htmlFor="children-target" required>
            <Select
              id="children-target"
              value={childrenTargetShopId}
              onChange={setChildrenTargetShopId}
              options={otherMains}
              placeholder="选择目标主店"
            />
          </Field>
        ) : null}

        {productCount > 0 ? (
          <Field label="商品如何处理" htmlFor="products-strategy" required>
            <Select
              id="products-strategy"
              value={productsStrategy}
              onChange={(value) => setProductsStrategy(value as ProductsStrategy)}
              options={[
                { value: 'reject', label: '若仍有商品则拒绝删除' },
                { value: 'move_to_shop', label: '迁移到其他店铺' },
                { value: 'archive', label: '归档商品' },
                { value: 'delete', label: '删除商品' },
              ]}
            />
          </Field>
        ) : null}

        {productCount > 0 && productsStrategy === 'move_to_shop' ? (
          <Field label="商品迁往" htmlFor="products-target" required>
            <Select
              id="products-target"
              value={productsTargetShopId}
              onChange={setProductsTargetShopId}
              options={(shopsQuery.data ?? [])
                .filter((shop) => shop.id !== shopId)
                .map((shop) => ({ value: shop.id, label: shop.name }))}
              placeholder="选择目标店铺"
            />
          </Field>
        ) : null}

        {credentialCount > 0 ? (
          <Field
            label="凭据如何处理"
            htmlFor="credentials-strategy"
            required
            description="凭据不能迁移到其他店铺,只能拒绝删除或一并删除。"
          >
            <Select
              id="credentials-strategy"
              value={credentialsStrategy}
              onChange={(value) => setCredentialsStrategy(value as CredentialsStrategy)}
              options={[
                { value: 'reject', label: '若仍有凭据则拒绝删除' },
                { value: 'delete', label: '同时删除凭据' },
              ]}
            />
          </Field>
        ) : null}

        <Field
          label="二次确认"
          htmlFor="confirm-shop-name"
          required
          description={`请完整输入店铺名称「${shopName}」`}
        >
          <Input
            id="confirm-shop-name"
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            autoComplete="off"
          />
        </Field>
      </div>
    </Dialog>
  );
}
