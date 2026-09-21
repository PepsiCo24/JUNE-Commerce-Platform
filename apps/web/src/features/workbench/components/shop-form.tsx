'use client';

import {
  PLATFORM_ACCOUNT_MAX,
  SHOP_NAME_MAX,
  TARGET_PLATFORMS,
  shopCreateSchema,
  shopUpdateSchema,
  type AlipayAccountSummary,
  type PageResult,
  type ShopDetail,
} from '@june/shared';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { CharCounter, Field, Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/toggle';
import { api } from '@/lib/api/client';

import { useShopOptions } from '../hooks/use-options';
import { useShopMutations } from '../hooks/use-shops';
import { SHOP_ERROR_COPY, describeWithOverrides } from '../lib/error-copy';
import { fieldErrorsFromApi, fieldErrorsFromZod } from '../lib/form';
import { workbenchKeys } from '../lib/keys';

import { InlineAlert } from './inline-alert';

export function ShopForm({ shop }: { shop?: ShopDetail }): React.JSX.Element {
  const router = useRouter();
  const shops = useShopOptions();
  const alipayOptions = useAlipayOptions();
  const { create, update } = useShopMutations();
  const editing = Boolean(shop);

  const [name, setName] = useState(shop?.name ?? '');
  const [parentId, setParentId] = useState<string | null>(shop?.parentId ?? null);
  const [platform, setPlatform] = useState(shop?.platform ?? '');
  const [platformAccount, setPlatformAccount] = useState(shop?.platformAccount ?? '');
  const [loginPassword, setLoginPassword] = useState('');
  const [clearLoginPassword, setClearLoginPassword] = useState(false);
  const [phone, setPhone] = useState(shop?.phone ?? shop?.contactInfo ?? '');
  const [alipayAccountId, setAlipayAccountId] = useState<string | null>(shop?.alipayAccount?.id ?? null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mainShops = (shops.data ?? []).filter((item) => item.type === 'MAIN' && item.id !== shop?.id);
  const submitting = create.isPending || update.isPending;

  const platformOptions = [
    { value: '__none__', label: '未选择' },
    ...TARGET_PLATFORMS.map((item) => ({ value: item.value, label: item.label })),
  ];
  const platformSelectValue =
    !platform
      ? '__none__'
      : TARGET_PLATFORMS.some((item) => item.value === platform)
        ? platform
        : platform;

  async function submit(): Promise<void> {
    setFormError(null);
    setFieldErrors({});

    if (editing && shop) {
      const payload = {
        name,
        platform: platform || null,
        platformAccount: platformAccount.trim() || null,
        phone: phone.trim() || null,
        alipayAccountId,
        parentId,
        ...(clearLoginPassword
          ? { clearLoginPassword: true as const }
          : loginPassword
            ? { loginPassword }
            : {}),
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

    const payload = {
      name,
      parentId,
      platform: platform || null,
      platformAccount: platformAccount.trim() || null,
      phone: phone.trim() || null,
      alipayAccountId,
      ...(loginPassword ? { loginPassword } : {}),
    };
    const parsed = shopCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod(parsed.error));
      return;
    }
    try {
      const created = await create.mutateAsync(parsed.data);
      toast.success(created.type === 'SUB' ? '子店已创建' : '主店已创建');
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
        description="记录店铺属性、账号与绑定信息。"
        breadcrumbs={[
          { label: '店铺', href: '/workbench/shops' },
          { label: editing ? '编辑' : '新建' },
        ]}
      />

      {formError ? <InlineAlert>{formError}</InlineAlert> : null}

      <div className="space-y-4">
        <Field label="店铺属性" htmlFor="shop-parent" description="主店铺或挂接在主店下的子店铺">
          <Select
            id="shop-parent"
            value={parentId ?? '__none__'}
            onChange={(value) => setParentId(value === '__none__' ? null : value)}
            options={[
              { value: '__none__', label: '主店铺' },
              ...mainShops.map((item) => ({ value: item.id, label: `子店铺 · ${item.name}` })),
            ]}
          />
        </Field>
        <Field
          label="店铺名称"
          htmlFor="shop-name"
          required
          error={fieldErrors.name}
          addon={<CharCounter value={name} max={SHOP_NAME_MAX} />}
        >
          <Input id="shop-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="店铺平台" htmlFor="shop-platform" error={fieldErrors.platform}>
          <Select
            id="shop-platform"
            value={platformSelectValue}
            onChange={(value) => setPlatform(value === '__none__' ? '' : value)}
            options={
              platform && !TARGET_PLATFORMS.some((item) => item.value === platform)
                ? [...platformOptions, { value: platform, label: platform }]
                : platformOptions
            }
          />
        </Field>
        <Field
          label="店铺账号"
          htmlFor="shop-platform-account"
          error={fieldErrors.platformAccount}
          addon={<CharCounter value={platformAccount} max={PLATFORM_ACCOUNT_MAX} />}
        >
          <Input
            id="shop-platform-account"
            value={platformAccount}
            onChange={(event) => setPlatformAccount(event.target.value)}
            autoComplete="username"
          />
        </Field>
        <Field
          label={editing ? '密码' : '密码(可选)'}
          htmlFor="shop-login-password"
          description={
            editing
              ? shop?.hasPrimaryPassword
                ? '留空表示保留原密码。'
                : '填写后将保存登录密码。'
              : undefined
          }
          error={fieldErrors.loginPassword}
        >
          <Input
            id="shop-login-password"
            type="password"
            value={loginPassword}
            disabled={clearLoginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
            autoComplete="new-password"
            placeholder={editing && shop?.hasPrimaryPassword ? '••••••••' : undefined}
          />
        </Field>
        {editing && shop?.hasPrimaryPassword ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border-default px-3 py-2">
            <div>
              <p className="text-sm text-fg">清除密码</p>
              <p className="text-xs text-fg-muted">仅清除密码，店铺账号仍保留</p>
            </div>
            <Switch
              checked={clearLoginPassword}
              onChange={(checked) => {
                setClearLoginPassword(checked);
                if (checked) setLoginPassword('');
              }}
              aria-label="清除密码"
            />
          </div>
        ) : null}
        <Field label="绑定支付宝账户" htmlFor="shop-alipay" error={fieldErrors.alipayAccountId}>
          <Select
            id="shop-alipay"
            value={alipayAccountId ?? '__none__'}
            onChange={(value) => setAlipayAccountId(value === '__none__' ? null : value)}
            options={[
              { value: '__none__', label: '不绑定' },
              ...(alipayOptions.data ?? []).map((item) => ({
                value: item.id,
                label: `${item.name} · ${item.phoneMasked}`,
              })),
            ]}
          />
        </Field>
        <Field label="手机号" htmlFor="shop-phone" error={fieldErrors.phone}>
          <Input
            id="shop-phone"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            autoComplete="tel"
          />
        </Field>

        <div className="flex gap-2">
          <Button loading={submitting} onClick={() => void submit()}>
            {editing ? '保存' : '创建'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => router.push(shop ? `/workbench/shops/${shop.id}` : '/workbench/shops')}
          >
            取消
          </Button>
        </div>
      </div>
    </div>
  );
}

function useAlipayOptions() {
  return useQuery({
    queryKey: workbenchKeys.alipayList({ page: 1, pageSize: 100 }),
    queryFn: async () => {
      const result = await api.get<PageResult<AlipayAccountSummary>>('/alipay-accounts', {
        query: { page: 1, pageSize: 100 },
      });
      return result.items;
    },
    staleTime: 30_000,
  });
}
