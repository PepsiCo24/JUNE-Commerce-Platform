'use client';

import {
  SHOP_NAME_MAX,
  shopCreateSchema,
  shopUpdateSchema,
  type ShopCreateInput,
  type ShopDetail,
  type ShopUpdateInput,
} from '@june/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { CharCounter, Field, Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/toggle';

import { useShopOptions } from '../hooks/use-options';
import { useShopMutations } from '../hooks/use-shops';
import { SHOP_ERROR_COPY, describeWithOverrides } from '../lib/error-copy';
import { fieldErrorsFromApi, fieldErrorsFromZod } from '../lib/form';

import { InlineAlert } from './inline-alert';

export function ShopForm({ shop }: { shop?: ShopDetail }): React.JSX.Element {
  const router = useRouter();
  const shops = useShopOptions();
  const { create, update } = useShopMutations();
  const editing = Boolean(shop);

  const [name, setName] = useState(shop?.name ?? '');
  const [parentId, setParentId] = useState<string | null>(shop?.parentId ?? null);
  const [platform, setPlatform] = useState(shop?.platform ?? '');
  const [url, setUrl] = useState(shop?.url ?? '');
  const [description, setDescription] = useState(shop?.description ?? '');
  const [contactName, setContactName] = useState(shop?.contactName ?? '');
  const [contactInfo, setContactInfo] = useState(shop?.contactInfo ?? '');
  const [note, setNote] = useState(shop?.note ?? '');
  const [status, setStatus] = useState<'ACTIVE' | 'PAUSED' | 'CLOSED'>(shop?.status ?? 'ACTIVE');
  const [propagateToChildren, setPropagateToChildren] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mainShops = (shops.data ?? []).filter((item) => item.type === 'MAIN' && item.id !== shop?.id);
  const submitting = create.isPending || update.isPending;

  async function submit(): Promise<void> {
    setFormError(null);
    setFieldErrors({});

    if (editing && shop) {
      const payload: ShopUpdateInput = {
        name,
        platform: platform || null,
        url: url || null,
        description: description || null,
        contactName: contactName || null,
        contactInfo: contactInfo || null,
        note: note || null,
        status,
        parentId,
        propagateToChildren,
      };
      const parsed = shopUpdateSchema.safeParse(payload);
      if (!parsed.success) {
        setFieldErrors(fieldErrorsFromZod(parsed.error));
        return;
      }
      try {
        await update.mutateAsync({ id: shop.id, input: parsed.data });
        toast.success('店铺已更新');
        router.push(`/workbench/shops/${shop.id}`);
      } catch (error) {
        setFieldErrors(fieldErrorsFromApi(error));
        setFormError(describeWithOverrides(error, SHOP_ERROR_COPY));
      }
      return;
    }

    const payload: ShopCreateInput = {
      name,
      parentId,
      platform: platform || null,
      url: url || null,
      description: description || null,
      contactName: contactName || null,
      contactInfo: contactInfo || null,
      note: note || null,
      status,
    };
    const parsed = shopCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod(parsed.error));
      return;
    }
    try {
      const created = await create.mutateAsync(parsed.data);
      toast.success(created.type === 'SUB' ? '子店已创建,未填写的字段已继承自主店' : '主店已创建');
      router.push(`/workbench/shops/${created.id}`);
    } catch (error) {
      setFieldErrors(fieldErrorsFromApi(error));
      setFormError(describeWithOverrides(error, SHOP_ERROR_COPY));
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={editing ? '编辑店铺' : '新建店铺'}
        description={editing ? '子店显式填写的字段会覆盖继承值。' : '填写主店或选择挂接的主店以创建子店。'}
        breadcrumbs={[
          { label: '店铺', href: '/workbench/shops' },
          { label: editing ? '编辑' : '新建' },
        ]}
      />

      {parentId ? (
        <InlineAlert tone="info">
          创建子店时,未填写的平台 / 联系人 / 联系方式 / 备注会继承自主店;账号密码不会继承。
        </InlineAlert>
      ) : null}
      {formError ? <InlineAlert>{formError}</InlineAlert> : null}

      <div className="space-y-4">
        <Field label="名称" htmlFor="shop-name" required error={fieldErrors.name} addon={<CharCounter value={name} max={SHOP_NAME_MAX} />}>
          <Input id="shop-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="挂接主店" htmlFor="shop-parent" description="不选则创建为主店">
          <Select
            id="shop-parent"
            value={parentId ?? '__none__'}
            onChange={(value) => setParentId(value === '__none__' ? null : value)}
            options={[
              { value: '__none__', label: '作为主店' },
              ...mainShops.map((item) => ({ value: item.id, label: item.name })),
            ]}
          />
        </Field>
        <Field label="平台" htmlFor="shop-platform" error={fieldErrors.platform}>
          <Input id="shop-platform" value={platform} onChange={(event) => setPlatform(event.target.value)} />
        </Field>
        <Field label="店铺链接" htmlFor="shop-url" error={fieldErrors.url}>
          <Input id="shop-url" value={url} onChange={(event) => setUrl(event.target.value)} />
        </Field>
        <Field label="简介" htmlFor="shop-desc">
          <Textarea id="shop-desc" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label="联系人" htmlFor="shop-contact-name">
          <Input id="shop-contact-name" value={contactName} onChange={(event) => setContactName(event.target.value)} />
        </Field>
        <Field label="联系方式" htmlFor="shop-contact-info">
          <Input id="shop-contact-info" value={contactInfo} onChange={(event) => setContactInfo(event.target.value)} />
        </Field>
        <Field label="备注" htmlFor="shop-note">
          <Textarea id="shop-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <Field label="状态" htmlFor="shop-status">
          <Select
            id="shop-status"
            value={status}
            onChange={(value) => setStatus(value as 'ACTIVE' | 'PAUSED' | 'CLOSED')}
            options={[
              { value: 'ACTIVE', label: '启用' },
              { value: 'PAUSED', label: '暂停' },
              { value: 'CLOSED', label: '关闭' },
            ]}
          />
        </Field>
        {editing && shop?.type === 'MAIN' ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border-default px-3 py-2">
            <div>
              <p className="text-sm text-fg">同步到未覆盖的子店</p>
              <p className="text-xs text-fg-muted">已被子店覆盖的字段不会被改写</p>
            </div>
            <Switch checked={propagateToChildren} onChange={setPropagateToChildren} aria-label="同步到未覆盖的子店" />
          </div>
        ) : null}

        <div className="flex gap-2">
          <Button loading={submitting} onClick={() => void submit()}>
            {editing ? '保存' : '创建'}
          </Button>
          <Button variant="ghost" onClick={() => router.push(shop ? `/workbench/shops/${shop.id}` : '/workbench/shops')}>
            取消
          </Button>
        </div>
      </div>
    </div>
  );
}
