'use client';

import {
  DEFAULT_MODEL_LIMITS,
  PROVIDER_KINDS,
  type AdminModelConfigView,
  type AdminProviderView,
  type ModelSelectionPolicy,
  type ProviderTestResult,
} from '@june/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { ModelDeleteResult } from '@/features/admin/api/types';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { fieldErrorsOf, toastApiError } from '@/features/admin/lib/errors';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Checkbox, RadioGroup, Switch } from '@/components/ui/toggle';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { useSse } from '@/providers/sse-provider';
import { formatDateTime } from '@/lib/utils';

const KIND_LABEL: Record<(typeof PROVIDER_KINDS)[number], string> = {
  OPENAI: 'OpenAI',
  GEMINI: 'Gemini',
  ARK_SEEDREAM: '火山方舟 Seedream',
  ALIYUN_WANX: '通义万相',
  BFL_FLUX: 'FLUX',
  OPENAI_COMPATIBLE: 'OpenAI 兼容',
  MOCK: '[MOCK] 模拟供应商',
};

export function ModelsScreen(): React.JSX.Element {
  const { configVersions } = useSse();
  const modelsVersion = configVersions.models ?? 0;
  const [tab, setTab] = useState('providers');

  return (
    <div className="space-y-5">
      <PageHeader
        title="模型"
        description="供应商 API Key 只显示掩码,可替换,绝不回传明文。MOCK 供应商仅用于压测。"
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'providers', label: '供应商' },
          { value: 'models', label: '模型' },
          { value: 'policy', label: '选择策略' },
        ]}
      />
      {tab === 'providers' ? <ProvidersPanel version={modelsVersion} /> : null}
      {tab === 'models' ? <ModelsPanel version={modelsVersion} /> : null}
      {tab === 'policy' ? <PolicyPanel version={modelsVersion} /> : null}
    </div>
  );
}

function ProvidersPanel({ version }: { version: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const [editing, setEditing] = useState<AdminProviderView | 'new' | null>(null);

  const listQuery = useQuery({
    queryKey: adminKeys.providers(version),
    queryFn: ({ signal }) => adminApi.get<AdminProviderView[]>(ADMIN_PATHS.models.providers, { signal }),
  });

  const test = useMutation({
    mutationFn: (id: string) => adminApi.post<ProviderTestResult>(ADMIN_PATHS.models.providerTest(id)),
    onSuccess: (result) => {
      toast[result.ok ? 'success' : 'error'](result.ok ? '连接成功' : '连接失败', { description: result.message });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
    onError: (error) => toastApiError(error, '连接测试失败'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => adminApi.delete<ModelDeleteResult>(ADMIN_PATHS.models.provider(id)),
    onSuccess: (result) => {
      toast.success(result.message);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
    onError: (error) => toastApiError(error, '无法删除供应商'),
  });

  const columns: Array<Column<AdminProviderView>> = [
    {
      key: 'name',
      header: '供应商',
      render: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-fg-muted">{KIND_LABEL[row.kind]} · {row.slug}</p>
        </div>
      ),
    },
    { key: 'enabled', header: '状态', render: (row) => <StatusBadge status={row.enabled ? 'ACTIVE' : 'DISABLED'} /> },
    {
      key: 'key',
      header: 'API Key',
      render: (row) => (
        <span className="font-mono text-xs">{row.apiKeyMasked ?? (row.hasCredential ? '已配置' : '未配置')}</span>
      ),
    },
    {
      key: 'test',
      header: '最近测试',
      hideOnMobile: true,
      render: (row) =>
        row.lastTestedAt
          ? `${row.lastTestOk ? '成功' : '失败'} · ${formatDateTime(row.lastTestedAt)}`
          : '未测试',
    },
    {
      key: 'actions',
      header: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={() => setEditing(row)}>
            编辑
          </Button>
          <Button size="sm" variant="secondary" loading={test.isPending} onClick={() => test.mutate(row.id)}>
            测试连接
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              const ok = await confirm({
                title: '删除该供应商?',
                description: '名下仍有模型时会改为停用,不会硬删。',
                danger: true,
                requireText: row.slug,
                confirmLabel: '删除',
              });
              if (ok) remove.mutate(row.id);
            }}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {confirmNode}
      <Button onClick={() => setEditing('new')}>新增供应商</Button>
      {listQuery.isPending ? <LoadingState /> : null}
      {listQuery.isError ? <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : null}
      <DataTable
        columns={columns}
        rows={listQuery.data ?? []}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        emptyMessage="还没有供应商"
      />
      {editing ? (
        <ProviderDialog
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
          }}
        />
      ) : null}
    </div>
  );
}

function ProviderDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: AdminProviderView | null;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const isNew = !provider;
  const [name, setName] = useState(provider?.name ?? '');
  const [slug, setSlug] = useState(provider?.slug ?? '');
  const [kind, setKind] = useState(provider?.kind ?? 'OPENAI');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [rateLimitPerMinute, setRateLimitPerMinute] = useState(String(provider?.rateLimitPerMinute ?? 0));
  const [maxConcurrency, setMaxConcurrency] = useState(String(provider?.maxConcurrency ?? 0));

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name,
        baseUrl,
        enabled,
        rateLimitPerMinute: Number(rateLimitPerMinute) || 0,
        maxConcurrency: Number(maxConcurrency) || 0,
      };
      if (clearApiKey) body.apiKey = '';
      else if (apiKey) body.apiKey = apiKey;
      if (isNew) {
        body.slug = slug;
        body.kind = kind;
        return adminApi.post(ADMIN_PATHS.models.providers, body);
      }
      return adminApi.patch(ADMIN_PATHS.models.provider(provider.id), body);
    },
    onSuccess: () => {
      toast.success(isNew ? '已创建供应商' : '已保存');
      onSaved();
    },
    onError: (error) => toastApiError(error, '保存供应商失败'),
  });

  const errors = fieldErrorsOf(save.error);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      theme="light"
      title={isNew ? '新增供应商' : `编辑 ${provider.name}`}
      description="API Key 只在提交时发送一次,读接口只返回掩码。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="名称" htmlFor="p-name" required error={errors.name}>
          <Input id="p-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        {isNew ? (
          <>
            <Field label="slug" htmlFor="p-slug" required error={errors.slug}>
              <Input id="p-slug" value={slug} onChange={(event) => setSlug(event.target.value)} />
            </Field>
            <Field label="协议" htmlFor="p-kind">
              <Select
                id="p-kind"
                value={kind}
                onChange={(value) => setKind(value as (typeof PROVIDER_KINDS)[number])}
                options={PROVIDER_KINDS.map((item) => ({ value: item, label: KIND_LABEL[item] }))}
              />
            </Field>
          </>
        ) : null}
        <Field label="API 地址" htmlFor="p-url" required error={errors.baseUrl}>
          <Input id="p-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </Field>
        <Field
          label={isNew ? 'API Key' : '替换 API Key'}
          htmlFor="p-key"
          description={
            isNew
              ? '明文只提交一次,之后只显示掩码。'
              : `当前掩码:${provider.apiKeyMasked ?? '未配置'}。留空表示不改;输入空格以外的内容才会替换。`
          }
          error={errors.apiKey}
        >
          <Input
            id="p-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            placeholder={isNew ? '' : '不回传明文,在此粘贴新密钥以替换'}
            disabled={clearApiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
        {!isNew ? (
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={clearApiKey}
              onChange={(checked) => {
                setClearApiKey(checked);
                if (checked) setApiKey('');
              }}
            />
            清除已保存的 API Key
          </label>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={enabled} onChange={setEnabled} aria-label="启用" />
          启用
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="每分钟限流(0=不限)" htmlFor="p-rate">
            <Input id="p-rate" type="number" min={0} value={rateLimitPerMinute} onChange={(event) => setRateLimitPerMinute(event.target.value)} />
          </Field>
          <Field label="并发上限(0=跟全局)" htmlFor="p-cc">
            <Input id="p-cc" type="number" min={0} value={maxConcurrency} onChange={(event) => setMaxConcurrency(event.target.value)} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function ModelsPanel({ version }: { version: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const [editing, setEditing] = useState<AdminModelConfigView | 'new' | null>(null);

  const providersQuery = useQuery({
    queryKey: adminKeys.providers(version),
    queryFn: ({ signal }) => adminApi.get<AdminProviderView[]>(ADMIN_PATHS.models.providers, { signal }),
  });
  const listQuery = useQuery({
    queryKey: adminKeys.modelConfigs(version),
    queryFn: ({ signal }) => adminApi.get<AdminModelConfigView[]>(ADMIN_PATHS.models.list, { signal }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => adminApi.delete<ModelDeleteResult>(ADMIN_PATHS.models.detail(id)),
    onSuccess: (result) => {
      toast.success(result.message);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
    onError: (error) => toastApiError(error, '无法删除模型'),
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => adminApi.post(ADMIN_PATHS.models.setDefault(id)),
    onSuccess: () => {
      toast.success('已设为默认');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
    onError: (error) => toastApiError(error, '无法设为默认'),
  });

  const columns: Array<Column<AdminModelConfigView>> = [
    {
      key: 'name',
      header: '模型',
      render: (row) => (
        <div>
          <p className="font-medium">
            {row.displayName}
            {row.providerKind === 'MOCK' ? <Badge size="sm" className="ml-2" tone="warning">MOCK</Badge> : null}
          </p>
          <p className="text-xs text-fg-muted">{row.providerName} · {row.modelKey}</p>
        </div>
      ),
    },
    { key: 'caps', header: '能力', hideOnMobile: true, render: (row) => row.capabilities.join(', ') },
    { key: 'enabled', header: '启用', render: (row) => <StatusBadge status={row.enabled ? 'ACTIVE' : 'DISABLED'} /> },
    { key: 'default', header: '默认', render: (row) => (row.isDefault ? '是' : '—') },
    { key: 'refs', header: '任务引用', numeric: true, hideOnMobile: true, render: (row) => row.taskRefCount },
    {
      key: 'actions',
      header: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={() => setEditing(row)}>
            编辑
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDefault.mutate(row.id)}>
            设默认
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              const ok = await confirm({
                title: '删除该模型?',
                description: row.taskRefCount > 0 ? `已被 ${row.taskRefCount} 条任务引用,将改为停用而非硬删。` : '未被任务引用时会删除。',
                danger: true,
                requireText: row.slug,
                confirmLabel: '删除',
              });
              if (ok) remove.mutate(row.id);
            }}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {confirmNode}
      <Button onClick={() => setEditing('new')}>新增模型</Button>
      {listQuery.isPending ? <LoadingState /> : null}
      {listQuery.isError ? <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : null}
      <DataTable
        columns={columns}
        rows={listQuery.data ?? []}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        emptyMessage="还没有模型"
      />
      {editing ? (
        <ModelDialog
          model={editing === 'new' ? null : editing}
          providers={providersQuery.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
          }}
        />
      ) : null}
    </div>
  );
}

function ModelDialog({
  model,
  providers,
  onClose,
  onSaved,
}: {
  model: AdminModelConfigView | null;
  providers: AdminProviderView[];
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const isNew = !model;
  const [providerId, setProviderId] = useState(model?.providerId ?? providers[0]?.id ?? '');
  const [slug, setSlug] = useState(model?.slug ?? '');
  const [displayName, setDisplayName] = useState(model?.displayName ?? '');
  const [modelKey, setModelKey] = useState(model?.modelKey ?? '');
  const [capabilities, setCapabilities] = useState(model?.capabilities.join(',') ?? 'TEXT_TO_IMAGE');
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const [visible, setVisible] = useState(model?.visible ?? true);
  const [limitsJson, setLimitsJson] = useState(JSON.stringify(model?.limits ?? DEFAULT_MODEL_LIMITS, null, 2));

  const save = useMutation({
    mutationFn: async () => {
      let limits: unknown = DEFAULT_MODEL_LIMITS;
      try {
        limits = JSON.parse(limitsJson) as unknown;
      } catch {
        throw new Error('limits 不是合法 JSON');
      }
      const caps = capabilities
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const body = {
        displayName,
        modelKey,
        capabilities: caps,
        enabled,
        visible,
        limits,
        defaultParams: model?.defaultParams ?? {},
      };
      if (isNew) {
        return adminApi.post(ADMIN_PATHS.models.list, { ...body, providerId, slug });
      }
      return adminApi.patch(ADMIN_PATHS.models.detail(model.id), body);
    },
    onSuccess: () => {
      toast.success(isNew ? '已创建模型' : '已保存');
      onSaved();
    },
    onError: (error) => toastApiError(error, '保存模型失败'),
  });

  const errors = fieldErrorsOf(save.error);

  return (
    <Dialog
      open
      theme="light"
      size="lg"
      title={isNew ? '新增模型' : `编辑 ${model.displayName}`}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {isNew ? (
          <>
            <Field label="供应商" htmlFor="m-provider" required>
              <Select
                id="m-provider"
                value={providerId}
                onChange={setProviderId}
                options={providers.map((item) => ({ value: item.id, label: item.name }))}
              />
            </Field>
            <Field label="slug" htmlFor="m-slug" required error={errors.slug}>
              <Input id="m-slug" value={slug} onChange={(event) => setSlug(event.target.value)} />
            </Field>
          </>
        ) : null}
        <Field label="显示名" htmlFor="m-name" required error={errors.displayName}>
          <Input id="m-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label="上游 modelKey" htmlFor="m-key" required error={errors.modelKey}>
          <Input id="m-key" value={modelKey} onChange={(event) => setModelKey(event.target.value)} />
        </Field>
        <Field label="能力(逗号分隔)" htmlFor="m-caps" description="TEXT_TO_IMAGE, IMAGE_EDIT, TEXT">
          <Input id="m-caps" value={capabilities} onChange={(event) => setCapabilities(event.target.value)} />
        </Field>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={enabled} onChange={setEnabled} /> 启用
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={visible} onChange={setVisible} /> 对用户可见
          </label>
        </div>
        <Field label="limits JSON" htmlFor="m-limits">
          <Textarea id="m-limits" rows={10} value={limitsJson} onChange={(event) => setLimitsJson(event.target.value)} className="font-mono text-xs" />
        </Field>
      </div>
    </Dialog>
  );
}

function PolicyPanel({ version }: { version: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const modelsQuery = useQuery({
    queryKey: adminKeys.modelConfigs(version),
    queryFn: ({ signal }) => adminApi.get<AdminModelConfigView[]>(ADMIN_PATHS.models.list, { signal }),
  });
  const policyQuery = useQuery({
    queryKey: adminKeys.modelPolicy(version),
    queryFn: ({ signal }) => adminApi.get<ModelSelectionPolicy>(ADMIN_PATHS.models.policy, { signal }),
  });

  const [draft, setDraft] = useState<ModelSelectionPolicy | null>(null);
  const policy = draft ?? policyQuery.data;

  const save = useMutation({
    mutationFn: (value: ModelSelectionPolicy) => adminApi.put(ADMIN_PATHS.models.policy, value),
    onSuccess: () => {
      toast.success('策略已保存。fixed 模式下前端隐藏选择器,改请求参数无法绕过。');
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
    onError: (error) => toastApiError(error, '保存策略失败'),
  });

  if (policyQuery.isPending) return <LoadingState />;
  if (policyQuery.isError) return <ErrorState error={policyQuery.error} onRetry={() => void policyQuery.refetch()} />;
  if (!policy) return <LoadingState />;

  const imageModels = (modelsQuery.data ?? []).filter((item) => item.capabilities.includes('TEXT_TO_IMAGE'));
  const textModels = (modelsQuery.data ?? []).filter((item) => item.capabilities.includes('TEXT'));
  const titlePolicy = policy.title ?? { mode: 'user_selectable' as const, fixedModelId: null, inheritFromText: true };

  return (
    <div className="space-y-6">
      <PolicyBlock
        title="生图"
        value={policy.image}
        models={imageModels}
        onChange={(image) => setDraft({ ...policy, image, title: titlePolicy })}
      />
      <PolicyBlock
        title="文案"
        value={policy.text}
        models={textModels}
        onChange={(text) => setDraft({ ...policy, text, title: titlePolicy })}
      />
      <section className="space-y-3 rounded-lg border border-border-default bg-surface p-4">
        <h2 className="font-semibold">标题生成</h2>
        <Checkbox
          id="title-inherit-text"
          checked={titlePolicy.inheritFromText}
          onChange={(checked) =>
            setDraft({
              ...policy,
              title: { ...titlePolicy, inheritFromText: checked },
            })
          }
          label="沿用文案模型策略(关闭后可单独固定标题模型)"
        />
        {!titlePolicy.inheritFromText ? (
          <PolicyBlock
            title="标题独立策略"
            value={titlePolicy}
            models={textModels}
            onChange={(title) => setDraft({ ...policy, title: { ...title, inheritFromText: false } })}
          />
        ) : null}
      </section>
      <Button
        loading={save.isPending}
        onClick={() =>
          save.mutate({
            image: policy.image,
            text: policy.text,
            title: titlePolicy,
          })
        }
      >
        保存策略
      </Button>
    </div>
  );
}

function PolicyBlock({
  title,
  value,
  models,
  onChange,
}: {
  title: string;
  value: ModelSelectionPolicy['image'];
  models: AdminModelConfigView[];
  onChange: (value: ModelSelectionPolicy['image']) => void;
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border-default bg-surface p-4 space-y-3">
      <h2 className="font-semibold">{title}</h2>
      <RadioGroup
        name={`${title}-mode`}
        value={value.mode}
        onChange={(mode) =>
          onChange({
            mode,
            fixedModelId: mode === 'fixed' ? value.fixedModelId ?? models[0]?.id ?? null : null,
          })
        }
        options={[
          { value: 'user_selectable', label: '用户可选', description: '工作台显示模型选择器' },
          { value: 'fixed', label: '固定单模型', description: '前端隐藏选择器,后端强制使用指定模型' },
        ]}
      />
      {value.mode === 'fixed' ? (
        <Field label="固定模型" htmlFor={`${title}-fixed`}>
          <Select
            id={`${title}-fixed`}
            value={value.fixedModelId}
            onChange={(id) => onChange({ ...value, fixedModelId: id })}
            options={models.map((item) => ({ value: item.id, label: item.displayName }))}
            placeholder="选择模型"
          />
        </Field>
      ) : null}
    </section>
  );
}
