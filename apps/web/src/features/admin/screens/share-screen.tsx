'use client';

import type { AdminShareConfigView } from '@june/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import { fieldErrorsOf, toastApiError } from '@/features/admin/lib/errors';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/toggle';

export function ShareScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: adminKeys.shareConfig,
    queryFn: ({ signal }) => adminApi.get<AdminShareConfigView>(ADMIN_PATHS.shareConfig, { signal }),
  });

  const [publicOrigin, setPublicOrigin] = useState('');
  const [wechatEnabled, setWechatEnabled] = useState(false);
  const [wechatAppId, setWechatAppId] = useState('');
  const [wechatSecret, setWechatSecret] = useState('');
  const [jsApiDomain, setJsApiDomain] = useState('');
  const [qqEnabled, setQqEnabled] = useState(false);
  const [qqAppId, setQqAppId] = useState('');

  useEffect(() => {
    if (!query.data) return;
    setPublicOrigin(query.data.publicOrigin);
    setWechatEnabled(query.data.wechat.enabled);
    setWechatAppId(query.data.wechat.appId);
    setJsApiDomain(query.data.wechat.jsApiDomain);
    setQqEnabled(query.data.qq.enabled);
    setQqAppId(query.data.qq.appId);
    setWechatSecret('');
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        publicOrigin,
        wechat: {
          enabled: wechatEnabled,
          appId: wechatAppId,
          jsApiDomain,
        },
        qq: { enabled: qqEnabled, appId: qqAppId },
      };
      if (wechatSecret !== '') {
        (body.wechat as Record<string, unknown>).appSecret = wechatSecret;
      }
      return adminApi.put<AdminShareConfigView>(ADMIN_PATHS.shareConfig, body);
    },
    onSuccess: () => {
      toast.success('分享配置已保存');
      setWechatSecret('');
      void queryClient.invalidateQueries({ queryKey: adminKeys.shareConfig });
    },
    onError: (error) => toastApiError(error, '保存失败'),
  });

  if (query.isPending) return <LoadingState message="加载分享配置" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const errors = fieldErrorsOf(save.error);
  const data = query.data;

  return (
    <div className="space-y-6">
      <PageHeader title="分享配置" description="appSecret 只显示掩码。传空字符串可清除已保存密钥;不填表示保持不变。" />
      <form
        className="max-w-xl space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="对外域名" htmlFor="share-origin" required error={errors.publicOrigin}>
          <Input id="share-origin" value={publicOrigin} onChange={(event) => setPublicOrigin(event.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={wechatEnabled} onChange={setWechatEnabled} /> 启用微信分享
        </label>
        <Field label="微信 appId" htmlFor="wx-id">
          <Input id="wx-id" value={wechatAppId} onChange={(event) => setWechatAppId(event.target.value)} />
        </Field>
        <Field
          label="替换微信 appSecret"
          htmlFor="wx-secret"
          description={`当前掩码:${data.wechat.appSecretMasked ?? '未配置'}。留空不改;输入内容才会替换,不会回传明文。`}
        >
          <Input
            id="wx-secret"
            type="password"
            autoComplete="new-password"
            value={wechatSecret}
            placeholder="不回传明文"
            onChange={(event) => setWechatSecret(event.target.value)}
          />
        </Field>
        <Field label="JS 安全域名" htmlFor="wx-domain">
          <Input id="wx-domain" value={jsApiDomain} onChange={(event) => setJsApiDomain(event.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={qqEnabled} onChange={setQqEnabled} /> 启用 QQ 分享
        </label>
        <Field label="QQ appId" htmlFor="qq-id">
          <Input id="qq-id" value={qqAppId} onChange={(event) => setQqAppId(event.target.value)} />
        </Field>
        <Button type="submit" loading={save.isPending}>
          保存
        </Button>
      </form>
    </div>
  );
}
