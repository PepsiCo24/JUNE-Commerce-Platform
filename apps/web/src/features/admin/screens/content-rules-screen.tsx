'use client';

import { PAGE_SIZE_DEFAULT, type AdminContentRuleView, type PageResult } from '@june/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { ContentRuleVersionView } from '@/features/admin/api/types';
import { JsonBlock } from '@/features/admin/components/json-block';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { fieldErrorsOf, toastApiError } from '@/features/admin/lib/errors';
import { PLATFORM_OPTIONS, RULE_ACTION_LABELS, RULE_TYPE_LABELS, labelOf } from '@/features/admin/lib/labels';
import { compactQuery, emptyPage } from '@/features/admin/lib/query';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/ui/table';
import { Checkbox, Switch } from '@/components/ui/toggle';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { type: 'ALL', enabled: 'ALL', page: '1' };
const RULE_TYPES = ['SYSTEM_PROMPT', 'BANNED_WORD', 'BANNED_PHRASE', 'BANNED_CATEGORY', 'PLATFORM_RULE'] as const;
const RULE_ACTIONS = ['BLOCK', 'REWRITE', 'WARN'] as const;

export function ContentRulesScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);
  const page = Math.max(1, Number(filters.page) || 1);
  const [editing, setEditing] = useState<AdminContentRuleView | 'new' | null>(null);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);

  const params = compactQuery({
    type: filters.type,
    enabled: filters.enabled,
    page,
    pageSize: PAGE_SIZE_DEFAULT,
  });

  const listQuery = useQuery({
    queryKey: adminKeys.contentRules(params),
    queryFn: ({ signal }) =>
      adminApi.get<PageResult<AdminContentRuleView>>(ADMIN_PATHS.contentRules.list, { signal, query: params }),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      adminApi.post(ADMIN_PATHS.contentRules.enabled(input.id), { enabled: input.enabled }),
    onSuccess: () => {
      toast.success('已更新启用状态');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'content-rules'] });
    },
    onError: (error) => toastApiError(error, '无法切换规则'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => adminApi.delete(ADMIN_PATHS.contentRules.detail(id)),
    onSuccess: () => {
      toast.success('已删除规则');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'content-rules'] });
    },
    onError: (error) => toastApiError(error, '无法删除规则'),
  });

  const pageData = listQuery.data ?? emptyPage<AdminContentRuleView>();

  const columns: Array<Column<AdminContentRuleView>> = [
    {
      key: 'name',
      header: '规则',
      render: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-fg-muted">
            {labelOf(RULE_TYPE_LABELS, row.type)} · {labelOf(RULE_ACTION_LABELS, row.action)} · v{row.version}
          </p>
        </div>
      ),
    },
    {
      key: 'platforms',
      header: '平台',
      hideOnMobile: true,
      render: (row) => (row.platforms.length === 0 ? '全部' : row.platforms.join(', ')),
    },
    { key: 'enabled', header: '状态', render: (row) => <StatusBadge status={row.enabled ? 'ACTIVE' : 'DISABLED'} /> },
    {
      key: 'scope',
      header: '作用域',
      hideOnMobile: true,
      render: (row) => (
        <span className="text-xs text-fg-muted">
          {row.applyToInput ? '输入' : ''}
          {row.applyToInput && row.applyToOutput ? ' / ' : ''}
          {row.applyToOutput ? '输出' : ''}
        </span>
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
          <Button size="sm" variant="secondary" onClick={() => setVersionsFor(row.id)}>
            版本
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => toggle.mutate({ id: row.id, enabled: !row.enabled })}
          >
            {row.enabled ? '停用' : '启用'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              const ok = await confirm({
                title: '删除这条规则?',
                danger: true,
                requireText: row.name,
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
    <div className="space-y-5">
      {confirmNode}
      <PageHeader
        title="内容规则"
        description="系统提示词、违禁词与平台规则。每次修改都会写入版本快照。"
        actions={<Button onClick={() => setEditing('new')}>新增规则</Button>}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Select
            aria-label="类型"
            value={filters.type}
            onChange={(value) => setFilters({ type: value, page: '1' })}
            options={[
              { value: 'ALL', label: '全部类型' },
              ...RULE_TYPES.map((type) => ({ value: type, label: RULE_TYPE_LABELS[type] })),
            ]}
          />
        </div>
        <div className="w-36">
          <Select
            aria-label="启用状态"
            value={filters.enabled}
            onChange={(value) => setFilters({ enabled: value, page: '1' })}
            options={[
              { value: 'ALL', label: '全部' },
              { value: 'ENABLED', label: '已启用' },
              { value: 'DISABLED', label: '已停用' },
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
        rows={pageData.items}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        emptyMessage="还没有内容规则"
      />
      <Pagination
        page={pageData.page}
        pageSize={pageData.pageSize}
        total={pageData.total}
        onPageChange={(next) => setFilters({ page: String(next) })}
      />

      {editing ? (
        <RuleDialog
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ['admin', 'content-rules'] });
          }}
        />
      ) : null}

      {versionsFor ? <VersionsDialog ruleId={versionsFor} onClose={() => setVersionsFor(null)} /> : null}
    </div>
  );
}

function RuleDialog({
  rule,
  onClose,
  onSaved,
}: {
  rule: AdminContentRuleView | null;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const isNew = !rule;
  const [type, setType] = useState(rule?.type ?? 'BANNED_WORD');
  const [action, setAction] = useState(rule?.action ?? 'BLOCK');
  const [name, setName] = useState(rule?.name ?? '');
  const [platforms, setPlatforms] = useState<string[]>(rule?.platforms ?? []);
  const [applyToInput, setApplyToInput] = useState(rule?.applyToInput ?? true);
  const [applyToOutput, setApplyToOutput] = useState(rule?.applyToOutput ?? true);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [changeNote, setChangeNote] = useState('');
  const [payload, setPayload] = useState<Record<string, unknown>>(rule?.payload ?? defaultPayload('BANNED_WORD'));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        action,
        name,
        platforms,
        payload,
        applyToInput,
        applyToOutput,
        enabled,
        changeNote: changeNote || undefined,
      };
      if (isNew) return adminApi.post(ADMIN_PATHS.contentRules.list, { ...body, type });
      return adminApi.patch(ADMIN_PATHS.contentRules.detail(rule.id), body);
    },
    onSuccess: () => {
      toast.success(isNew ? '已创建规则' : '已保存规则');
      onSaved();
    },
    onError: (error) => toastApiError(error, '保存规则失败'),
  });

  const errors = fieldErrorsOf(save.error);

  return (
    <Dialog
      open
      theme="light"
      size="lg"
      title={isNew ? '新增内容规则' : `编辑 ${rule.name}`}
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
          <Field label="类型" htmlFor="rule-type">
            <Select
              id="rule-type"
              value={type}
              onChange={(value) => {
                setType(value);
                setPayload(defaultPayload(value));
              }}
              options={RULE_TYPES.map((item) => ({ value: item, label: RULE_TYPE_LABELS[item] }))}
            />
          </Field>
        ) : (
          <p className="text-sm text-fg-muted">类型不可改 · {labelOf(RULE_TYPE_LABELS, type)}</p>
        )}
        <Field label="名称" htmlFor="rule-name" required error={errors.name}>
          <Input id="rule-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="动作" htmlFor="rule-action">
          <Select
            id="rule-action"
            value={action}
            onChange={setAction}
            options={RULE_ACTIONS.map((item) => ({ value: item, label: RULE_ACTION_LABELS[item] }))}
          />
        </Field>
        <div>
          <p className="mb-2 text-sm font-medium">适用平台(空=全部)</p>
          <div className="flex flex-wrap gap-3">
            {PLATFORM_OPTIONS.map((item) => (
              <Checkbox
                key={item.value}
                label={item.label}
                checked={platforms.includes(item.value)}
                onChange={(checked) =>
                  setPlatforms(checked ? [...platforms, item.value] : platforms.filter((value) => value !== item.value))
                }
              />
            ))}
          </div>
        </div>
        <PayloadFields type={type} payload={payload} onChange={setPayload} />
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={applyToInput} onChange={setApplyToInput} /> 作用于输入
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={applyToOutput} onChange={setApplyToOutput} /> 作用于输出
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={enabled} onChange={setEnabled} /> 启用
          </label>
        </div>
        <Field label="变更说明" htmlFor="rule-note">
          <Input id="rule-note" value={changeNote} onChange={(event) => setChangeNote(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function PayloadFields({
  type,
  payload,
  onChange,
}: {
  type: string;
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}): React.JSX.Element {
  const text = typeof payload.text === 'string' ? payload.text : '';
  const words = Array.isArray(payload.words) ? payload.words.map(String).join('\n') : '';
  const patterns = Array.isArray(payload.patterns) ? payload.patterns.map(String).join('\n') : '';
  const keywords = Array.isArray(payload.keywords) ? payload.keywords.map(String).join('\n') : '';

  if (type === 'SYSTEM_PROMPT') {
    return (
      <Field label="提示词文本" htmlFor="p-text">
        <Textarea
          id="p-text"
          rows={6}
          value={text}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      </Field>
    );
  }
  if (type === 'BANNED_WORD') {
    return (
      <>
        <Field label="违禁词(每行一条)" htmlFor="p-words">
          <Textarea
            id="p-words"
            rows={6}
            value={words}
            onChange={(event) =>
              onChange({
                ...payload,
                words: event.target.value
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={payload.caseSensitive === true}
            onChange={(checked) => onChange({ ...payload, caseSensitive: checked })}
          />
          区分大小写
        </label>
      </>
    );
  }
  if (type === 'BANNED_PHRASE') {
    return (
      <>
        <Field label="正则(每行一条)" htmlFor="p-patterns">
          <Textarea
            id="p-patterns"
            rows={6}
            value={patterns}
            onChange={(event) =>
              onChange({
                ...payload,
                patterns: event.target.value
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field label="flags" htmlFor="p-flags" description="仅允许 imsu,禁止 g/y">
          <Input
            id="p-flags"
            value={typeof payload.flags === 'string' ? payload.flags : ''}
            onChange={(event) => onChange({ ...payload, flags: event.target.value })}
          />
        </Field>
      </>
    );
  }
  if (type === 'BANNED_CATEGORY') {
    return (
      <>
        <Field label="类别" htmlFor="p-cat">
          <Input
            id="p-cat"
            value={typeof payload.category === 'string' ? payload.category : ''}
            onChange={(event) => onChange({ ...payload, category: event.target.value })}
          />
        </Field>
        <Field label="说明" htmlFor="p-desc">
          <Input
            id="p-desc"
            value={typeof payload.description === 'string' ? payload.description : ''}
            onChange={(event) => onChange({ ...payload, description: event.target.value })}
          />
        </Field>
        <Field label="关键词(每行一条)" htmlFor="p-kw">
          <Textarea
            id="p-kw"
            rows={5}
            value={keywords}
            onChange={(event) =>
              onChange({
                ...payload,
                keywords: event.target.value
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      </>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="标题字数上限" htmlFor="p-title">
        <Input
          id="p-title"
          type="number"
          value={typeof payload.maxTitleChars === 'number' ? String(payload.maxTitleChars) : ''}
          onChange={(event) =>
            onChange({ ...payload, maxTitleChars: event.target.value ? Number(event.target.value) : undefined })
          }
        />
      </Field>
      <Field label="正文字数上限" htmlFor="p-body">
        <Input
          id="p-body"
          type="number"
          value={typeof payload.maxBodyChars === 'number' ? String(payload.maxBodyChars) : ''}
          onChange={(event) =>
            onChange({ ...payload, maxBodyChars: event.target.value ? Number(event.target.value) : undefined })
          }
        />
      </Field>
    </div>
  );
}

function defaultPayload(type: string): Record<string, unknown> {
  switch (type) {
    case 'SYSTEM_PROMPT':
      return { text: '' };
    case 'BANNED_WORD':
      return { words: [], caseSensitive: false };
    case 'BANNED_PHRASE':
      return { patterns: [], flags: 'i' };
    case 'BANNED_CATEGORY':
      return { category: '', description: '', keywords: [] };
    default:
      return {};
  }
}

function VersionsDialog({ ruleId, onClose }: { ruleId: string; onClose: () => void }): React.JSX.Element {
  const query = useQuery({
    queryKey: adminKeys.contentRuleVersions(ruleId),
    queryFn: ({ signal }) =>
      adminApi.get<ContentRuleVersionView[]>(ADMIN_PATHS.contentRules.versions(ruleId), { signal }),
  });

  return (
    <Dialog open theme="light" size="lg" title="规则版本历史" onOpenChange={(open) => !open && onClose()}>
      {query.isPending ? <p className="text-sm text-fg-muted">加载版本</p> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      <div className="space-y-4">
        {(query.data ?? []).map((item) => (
          <article key={item.id} className="space-y-2 rounded-md border border-border-default p-3">
            <p className="text-sm font-medium">
              v{item.version}
              <span className="ml-2 text-xs font-normal text-fg-muted">{formatDateTime(item.createdAt)}</span>
            </p>
            {item.changeNote ? <p className="text-xs text-fg-muted">{item.changeNote}</p> : null}
            <JsonBlock value={item.snapshot} />
          </article>
        ))}
        {query.data?.length === 0 ? <p className="text-sm text-fg-muted">没有版本记录</p> : null}
      </div>
    </Dialog>
  );
}
