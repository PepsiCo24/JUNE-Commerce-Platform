'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';
import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AdminSystemConfigView } from '@/features/admin/api/types';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { fieldErrorsOf, toastApiError } from '@/features/admin/lib/errors';
import { compactQuery } from '@/features/admin/lib/query';
import { ErrorState, ForbiddenState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { DataTable, type Column } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { group: '' };

export function SystemScreen(): React.JSX.Element {
  const { user } = useAdminAuth();
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const { filters, setFilters } = useUrlFilters(FILTERS);
  const [editing, setEditing] = useState<AdminSystemConfigView | 'new' | null>(null);
  const params = compactQuery({ group: filters.group });

  const listQuery = useQuery({
    queryKey: adminKeys.systemConfigs(params),
    queryFn: ({ signal }) =>
      adminApi.get<AdminSystemConfigView[]>(ADMIN_PATHS.systemConfigs.list, { signal, query: params }),
    enabled: Boolean(user?.isSuperAdmin),
  });

  const remove = useMutation({
    mutationFn: (key: string) => adminApi.delete(ADMIN_PATHS.systemConfigs.detail(key)),
    onSuccess: () => {
      toast.success('已删除配置');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'system-configs'] });
    },
    onError: (error) => toastApiError(error, '无法删除配置'),
  });

  if (!user?.isSuperAdmin) {
    return <ForbiddenState message="系统配置仅超级管理员可访问。角色判定在后端,前端隐藏入口只是体验优化。" />;
  }

  const columns: Array<Column<AdminSystemConfigView>> = [
    {
      key: 'key',
      header: '键',
      render: (row) => (
        <div>
          <p className="font-mono text-sm">{row.key}</p>
          <p className="text-xs text-fg-muted">{row.group} · {row.description ?? '无说明'}</p>
        </div>
      ),
    },
    {
      key: 'value',
      header: '值',
      render: (row) =>
        row.isSecret ? (
          <span className="font-mono text-xs">{row.valueMasked ?? '已配置(掩码)'}</span>
        ) : (
          <pre className="max-w-xs overflow-x-auto text-xs">{JSON.stringify(row.value)}</pre>
        ),
    },
    {
      key: 'flags',
      header: '标记',
      hideOnMobile: true,
      render: (row) => (
        <div className="flex gap-1">
          {row.isSecret ? <Badge size="sm" tone="warning">敏感</Badge> : null}
          {row.isPublic ? <Badge size="sm">公开</Badge> : null}
          <span className="text-xs text-fg-muted">v{row.version}</span>
        </div>
      ),
    },
    { key: 'updated', header: '更新', hideOnMobile: true, render: (row) => formatDateTime(row.updatedAt) },
    {
      key: 'actions',
      header: '操作',
      render: (row) => (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setEditing(row)}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              const ok = await confirm({
                title: '删除该配置?',
                description: '受保护的键(分享密钥、并发上限等)会被后端拒绝。',
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
      <PageHeader title="系统配置" description="敏感项只返回掩码。并发上限另有部署规格硬上限,超限会被拒绝。" />
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="按分组筛选"
          className="max-w-xs"
          value={filters.group}
          onChange={(event) => setFilters({ group: event.target.value })}
        />
        <Button onClick={() => setEditing('new')}>新增</Button>
      </div>
      {listQuery.isPending ? <LoadingState /> : null}
      {listQuery.isError ? <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : null}
      <DataTable
        columns={columns}
        rows={listQuery.data ?? []}
        rowKey={(row) => row.key}
        loading={listQuery.isPending}
        emptyMessage="没有配置项"
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
  const [group, setGroup] = useState(config?.group ?? 'system');
  const [description, setDescription] = useState(config?.description ?? '');
  const [valueText, setValueText] = useState(
    config?.isSecret ? '' : JSON.stringify(config?.value ?? null, null, 2),
  );
  const [isSecret, setIsSecret] = useState(config?.isSecret ?? false);
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: () => {
      let value: unknown = valueText;
      if (!isSecret) {
        try {
          value = JSON.parse(valueText) as unknown;
        } catch {
          throw new Error('非敏感值必须是合法 JSON');
        }
      }
      return adminApi.put(ADMIN_PATHS.systemConfigs.detail(isNew ? key : config.key), {
        value,
        isSecret,
        group,
        description: description || null,
        reason: reason || undefined,
      });
    },
    onSuccess: () => {
      toast.success('已保存');
      onSaved();
    },
    onError: (error) => toastApiError(error, '保存配置失败'),
  });

  const errors = fieldErrorsOf(save.error);

  return (
    <Dialog
      open
      theme="light"
      title={isNew ? '新增配置' : `编辑 ${config.key}`}
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
          <Field label="键" htmlFor="cfg-key" required>
            <Input id="cfg-key" value={key} onChange={(event) => setKey(event.target.value)} />
          </Field>
        ) : null}
        <Field label="分组" htmlFor="cfg-group">
          <Input id="cfg-group" value={group} onChange={(event) => setGroup(event.target.value)} />
        </Field>
        <Field label="说明" htmlFor="cfg-desc">
          <Input id="cfg-desc" value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field
          label={isSecret ? '明文(只提交一次)' : 'JSON 值'}
          htmlFor="cfg-value"
          description={config?.isSecret ? `当前掩码:${config.valueMasked ?? '—'}` : undefined}
          error={errors.value}
        >
          <Textarea id="cfg-value" rows={8} className="font-mono text-xs" value={valueText} onChange={(event) => setValueText(event.target.value)} />
        </Field>
        <Field label="变更原因" htmlFor="cfg-reason">
          <Input id="cfg-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
