'use client';

import { shareConfigUpdateSchema, type AdminShareConfigView } from '@june/shared';
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

export function ShareConfigScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: adminKeys.shareConfig,
    queryFn: ({ signal }) => adminApi.get<AdminShareConfigView>(ADMIN_PATHS.shareConfig, { signal }),
  });

  const [publicOrigin, setPublicOrigin] = useState('');
  const [wechatEnabled, setWechatEnabled] = useState(false);
  const [wechatAppId, setWechatAppId] = useState('');
  const [jsApiDomain, setJsApiDomain] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
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
    setAppSecret('');
    setClearSecret(false);
  }, [query.data]);

  const save = useMutation({
    mutationFn: async () => {
      const body: {
        publicOrigin: string;
        wechat: { enabled: boolean; appId: string; jsApiDomain: string; appSecret?: string };
        qq: { enabled: boolean; appId: string };
      } = {
        publicOrigin,
        wechat: { enabled: wechatEnabled, appId: wechatAppId, jsApiDomain },
        qq: { enabled: qqEnabled, appId: qqAppId },
      };
      if (clearSecret) body.wechat.appSecret = '';
      else if (appSecret) body.wechat.appSecret = appSecret;
      const parsed = shareConfigUpdateSchema.safeParse(body);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new Error(first?.message ?? '分享配置校验失败');
      }
      return adminApi.put<AdminShareConfigView>(ADMIN_PATHS.shareConfig, parsed.data);
    },
    onSuccess: () => {
      toast.success('分享配置已保存');
      setAppSecret('');
      setClearSecret(false);
      void queryClient.invalidateQueries({ queryKey: adminKeys.shareConfig });
    },
    onError: (error) => toastApiError(error, '保存分享配置失败'),
  });

  if (query.isPending) return <LoadingState message="加载分享配置" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const errors = fieldErrorsOf(save.error);
  const masked = query.data.wechat.appSecretMasked;

  return (
    <div className="space-y-6">
      <PageHeader
        title="分享配置"
        description="微信 appSecret 只显示掩码。明文只在提交时发送一次,空字符串表示清除。"
      />

      <form
        className="max-w-xl space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="对外分享域名" htmlFor="origin" required error={errors.publicOrigin}>
          <Input id="origin" value={publicOrigin} onChange={(event) => setPublicOrigin(event.target.value)} />
        </Field>

        <section className="space-y-3 rounded-lg border border-border-default bg-surface p-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch checked={wechatEnabled} onChange={setWechatEnabled} /> 微信分享
          </label>
          <Field label="微信 appId" htmlFor="wx-appid">
            <Input id="wx-appid" value={wechatAppId} onChange={(event) => setWechatAppId(event.target.value)} />
          </Field>
          <Field label="JS 安全域名" htmlFor="wx-js">
            <Input id="wx-js" value={jsApiDomain} onChange={(event) => setJsApiDomain(event.target.value)} />
          </Field>
          <Field
            label="替换 appSecret"
            htmlFor="wx-secret"
            description={
              masked
                ? `当前掩码:${masked}。留空表示不改。勾选清除会提交空字符串。`
                : '尚未配置。明文只提交一次,之后只显示掩码。'
            }
          >
            <Input
              id="wx-secret"
              type="password"
              autoComplete="new-password"
              value={appSecret}
              disabled={clearSecret}
              placeholder="不回传明文"
              onChange={(event) => setAppSecret(event.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={clearSecret}
              onChange={(checked) => {
                setClearSecret(checked);
                if (checked) setAppSecret('');
              }}
            />
            清除已保存的 appSecret
          </label>
        </section>

        <section className="space-y-3 rounded-lg border border-border-default bg-surface p-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch checked={qqEnabled} onChange={setQqEnabled} /> QQ 分享
          </label>
          <Field label="QQ appId" htmlFor="qq-appid">
            <Input id="qq-appid" value={qqAppId} onChange={(event) => setQqAppId(event.target.value)} />
          </Field>
        </section>

        <Button type="submit" loading={save.isPending}>
          保存
        </Button>
      </form>
    </div>
  );
}
