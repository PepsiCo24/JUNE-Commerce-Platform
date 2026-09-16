'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AdminSystemConfigView } from '@/features/admin/api/types';
import { JsonBlock } from '@/features/admin/components/json-block';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { fieldErrorsOf, toastApiError } from '@/features/admin/lib/errors';
import { compactQuery } from '@/features/admin/lib/query';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { Switch } from '@/components/ui/toggle';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { group: 'ALL' };

export function SystemConfigScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);
  const [editing, setEditing] = useState<AdminSystemConfigView | 'new' | null>(null);

  const params = compactQuery({ group: filters.group === 'ALL' ? '' : filters.group });
  const listQuery = useQuery({
    queryKey: adminKeys.systemConfigs(params),
    queryFn: ({ signal }) =>
      adminApi.get<AdminSystemConfigView[]>(ADMIN_PATHS.systemConfigs.list, { signal, query: params }),
  });

  const remove = useMutation({
    mutationFn: (key: string) => adminApi.delete(ADMIN_PATHS.systemConfigs.detail(key)),
    onSuccess: () => {
      toast.success('已删除配置');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'system-configs'] });
    },
    onError: (error) => toastApiError(error, '无法删除配置'),
  });

  const groups = useMemo(() => {
    const set = new Set((listQuery.data ?? []).map((item) => item.group).filter(Boolean));
    return Array.from(set).sort();
  }, [listQuery.data]);

  const columns: Array<Column<AdminSystemConfigView>> = [
    {
      key: 'key',
      header: '键',
      render: (row) => (
        <div>
          <p className="font-mono text-sm">{row.key}</p>
          <p className="text-xs text-fg-muted">{row.description ?? row.group}</p>
        </div>
      ),
    },
    {
      key: 'value',
      header: '值',
      render: (row) =>
        row.isSecret ? (
          <span className="font-mono text-xs">{row.valueMasked ?? (row.hasSecret ? '已配置' : '未配置')}</span>
        ) : (
          <span className="font-mono text-xs">{stringifyValue(row.value)}</span>
        ),
    },
    {
      key: 'flags',
      header: '标记',
      hideOnMobile: true,
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.isSecret ? <Badge size="sm" tone="warning">敏感</Badge> : null}
          {row.isPublic ? <Badge size="sm">公开</Badge> : null}
          <Badge size="sm">v{row.version}</Badge>
        </div>
      ),
    },
    { key: 'updated', header: '更新', hideOnMobile: true, render: (row) => formatDateTime(row.updatedAt) },
    {
      key: 'actions',
      header: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={() => setEditing(row)}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              const ok = await confirm({
                title: '删除该配置项?',
                description: '受保护的键(分享配置、并发上限等)不允许删除。',
                danger: true,
                requireText: row.key,
                confirmLabel: '删除',
              });
              if (ok) remove.mutate(row.key);
            }}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      {confirmNode}
      <PageHeader
        title="系统配置"
        description="敏感项只显示掩码,明文只在写入时提交。分享密钥请走分享配置页。"
        actions={<Button onClick={() => setEditing('new')}>新增配置</Button>}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Select
            aria-label="分组"
            value={filters.group}
            onChange={(value) => setFilters({ group: value })}
            options={[
              { value: 'ALL', label: '全部分组' },
              ...groups.map((group) => ({ value: group, label: group })),
            ]}
          />
        </div>
        {isFiltered ? (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            清空筛选
          </Button>
        ) : null}
      </div>

      {listQuery.isError ? <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : null}

      <DataTable
        columns={columns}
        rows={listQuery.data ?? []}
        rowKey={(row) => row.key}
        loading={listQuery.isPending}
        emptyMessage="还没有系统配置"
      />

      {editing ? (
        <ConfigDialog
          config={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ['admin', 'system-configs'] });
          }}
        />
      ) : null}
    </div>
  );
}

function ConfigDialog({
  config,
  onClose,
  onSaved,
}: {
  config: AdminSystemConfigView | null;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const isNew = !config;
  const [key, setKey] = useState(config?.key ?? '');
  const [group, setGroup] = useState(config?.group ?? 'general');
  const [description, setDescription] = useState(config?.description ?? '');
  const [isSecret, setIsSecret] = useState(config?.isSecret ?? false);
  const [isPublic, setIsPublic] = useState(config?.isPublic ?? false);
  const [valueText, setValueText] = useState(
    config && !config.isSecret ? JSON.stringify(config.value, null, 2) : '',
  );
  const [secretValue, setSecretValue] = useState('');
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: () => {
      let value: unknown = secretValue;
      if (!isSecret) {
        try {
          value = valueText ? (JSON.parse(valueText) as unknown) : null;
        } catch {
          throw new Error('值必须是合法 JSON');
        }
      }
      const body = {
        value,
        isSecret,
        isPublic,
        group,
        description: description || null,
        reason: reason || undefined,
      };
      return adminApi.put(ADMIN_PATHS.systemConfigs.detail(isNew ? key : config.key), body);
    },
    onSuccess: () => {
      toast.success('已保存配置');
      setSecretValue('');
      onSaved();
    },
    onError: (error) => toastApiError(error, '保存配置失败'),
  });

  const errors = fieldErrorsOf(save.error);

  return (
    <Dialog
      open
      theme="light"
      size="lg"
      title={isNew ? '新增系统配置' : `编辑 ${config.key}`}
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
        <Field label="键" htmlFor="cfg-key" required error={errors.key}>
          <Input id="cfg-key" value={key} disabled={!isNew} onChange={(event) => setKey(event.target.value)} />
        </Field>
        <Field label="分组" htmlFor="cfg-group">
          <Input id="cfg-group" value={group} onChange={(event) => setGroup(event.target.value)} />
        </Field>
        <Field label="说明" htmlFor="cfg-desc">
          <Input id="cfg-desc" value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={isSecret} onChange={setIsSecret} disabled={!isNew && Boolean(config?.isSecret)} /> 敏感
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={isPublic} onChange={setIsPublic} /> 公开(可被 SSE 热更新)
          </label>
        </div>
        {isSecret ? (
          <Field
            label="明文值"
            htmlFor="cfg-secret"
            description={
              config?.valueMasked
                ? `当前掩码:${config.valueMasked}。填写新值才会替换,不会回显旧明文。`
                : '明文只提交一次,读接口只返回掩码。'
            }
          >
            <Input
              id="cfg-secret"
              type="password"
              autoComplete="new-password"
              value={secretValue}
              onChange={(event) => setSecretValue(event.target.value)}
            />
          </Field>
        ) : (
          <Field label="JSON 值" htmlFor="cfg-json">
            <Textarea
              id="cfg-json"
              rows={8}
              className="font-mono text-xs"
              value={valueText}
              onChange={(event) => setValueText(event.target.value)}
            />
          </Field>
        )}
        {!isNew && !isSecret ? (
          <div>
            <p className="mb-1 text-xs text-fg-muted">当前值</p>
            <JsonBlock value={config.value} />
          </div>
        ) : null}
        <Field label="变更原因" htmlFor="cfg-reason">
          <Input id="cfg-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  } catch {
    return '—';
  }
}
