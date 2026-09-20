'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/toggle';
import { api } from '@/lib/api/client';
import { describeError } from '@/lib/api/errors';

import { useProductOptions, useShopOptions } from '../hooks/use-options';
import type { SaveResultsResponse } from '../lib/api-types';

export function SaveToProductDialog({
  open,
  onOpenChange,
  taskId,
  resultIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  resultIds: string[];
}): React.JSX.Element {
  const [shopId, setShopId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [productId, setProductId] = useState<string | null>(null);
  const [setAsCover, setSetAsCover] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const shopsQuery = useShopOptions();
  const optionsQuery = useProductOptions(q, shopId);

  const options = useMemo(
    () =>
      (optionsQuery.data ?? []).map((item) => ({
        value: item.id,
        label: item.sku ? `${item.name} (${item.sku})` : item.name,
        description: item.shopName,
      })),
    [optionsQuery.data],
  );

  async function submit(): Promise<void> {
    if (!productId) {
      toast.error('请选择要保存到的商品');
      return;
    }
    if (resultIds.length === 0) {
      toast.error('没有可保存的结果');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.post<SaveResultsResponse>(`/generation/tasks/${taskId}/save-to-product`, {
        productId,
        resultIds,
        setAsCover,
      });
      toast.success(
        result.skippedCount > 0
          ? `已保存 ${result.savedCount} 张,跳过 ${result.skippedCount} 张已有图片`
          : `已保存 ${result.savedCount} 张到商品`,
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      theme="dark"
      title="保存到商品"
      description="图片会复用同一份资产,不会复制文件。"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={submitting} onClick={() => void submit()}>
            保存
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="店铺" htmlFor="save-shop-id" required>
          <Select
            id="save-shop-id"
            value={shopId}
            onChange={(value) => {
              setShopId(value);
              setProductId(null);
            }}
            options={(shopsQuery.data ?? []).map((shop) => ({ value: shop.id, label: shop.name }))}
            placeholder={shopsQuery.isLoading ? '加载店铺' : '先选择店铺'}
          />
        </Field>
        <Field label="搜索本店商品" htmlFor="save-product-q">
          <Input
            id="save-product-q"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="名称或 SKU"
            disabled={!shopId}
          />
        </Field>
        <Field label="目标商品" htmlFor="save-product-id" required>
          <Select
            id="save-product-id"
            value={productId}
            onChange={setProductId}
            options={options}
            placeholder={!shopId ? '请先选择店铺' : optionsQuery.isLoading ? '加载中' : '选择商品'}
            disabled={!shopId}
          />
        </Field>
        <Checkbox
          checked={setAsCover}
          onChange={setSetAsCover}
          label="将第一张设为商品封面"
          id="save-as-cover"
        />
      </div>
    </Dialog>
  );
}
