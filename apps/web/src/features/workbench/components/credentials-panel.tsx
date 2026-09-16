'use client';

import {
  PAGE_SIZE_DEFAULT,
  PASSWORD_DISPLAY_MASK,
  type CredentialCreateInput,
  type CredentialRevealResponse,
  type CredentialSummary,
  type PageResult,
  type ShopSummary,
} from '@june/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import type { Column } from '@/components/ui/table';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { copyToClipboard, formatDateTime } from '@/lib/utils';
import { describeError } from '@/lib/api/errors';

import { useShopOptions } from '../hooks/use-options';
import { useReauth } from '../hooks/use-reauth';
import { workbenchKeys } from '../lib/keys';
import { fieldErrorsFromApi } from '../lib/form';

import { InlineAlert } from './inline-alert';

interface RevealedSecret {
  id: string;
  password: string;
  hideAt: number;
}

export function CredentialsOverviewPage(): React.JSX.Element {
  const shops = useShopOptions();
  const [shopId, setShopId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="店铺凭据"
        description="先选择店铺再查看凭据。密码默认掩码。查看或复制都需要重新验证登录密码,明文不会写入缓存。"
        breadcrumbs={[{ label: '工作台', href: '/workbench' }, { label: '凭据' }]}
      />
      <Field label="店铺" htmlFor="cred-shop">
        <Select
          id="cred-shop"
          value={shopId}
          onChange={setShopId}
          options={(shops.data ?? []).map((shop) => ({
            value: shop.id,
            label: shop.name,
            description: `${shop.credentialCount} 条凭据`,
          }))}
          placeholder={shops.isLoading ? '加载店铺' : '选择店铺'}
        />
      </Field>
      {shopId ? <CredentialsPanel key={shopId} shopId={shopId} shops={shops.data ?? []} /> : <EmptyState title="请先选择店铺" description="凭据按店铺隔离,选择后再列出。" />}
    </div>
  );
}

export function ShopCredentialsPage({ shopId }: { shopId: string }): React.JSX.Element {
  const shops = useShopOptions();
  const shop = shops.data?.find((item) => item.id === shopId);
  return (
    <div className="space-y-4">
      <PageHeader
        title={`${shop?.name ?? '店铺'}凭据`}
        description="密码默认掩码。查看与复制每次都要重新验证。"
        breadcrumbs={[
          { label: '店铺', href: '/workbench/shops' },
          { label: shop?.name ?? '详情', href: `/workbench/shops/${shopId}` },
          { label: '凭据' },
        ]}
      />
      <CredentialsPanel shopId={shopId} shops={shops.data ?? []} />
    </div>
  );
}

function CredentialsPanel({ shopId, shops }: { shopId: string; shops: ShopSummary[] }): React.JSX.Element {
  const queryClient = useQueryClient();
  const reauth = useReauth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [submittedQ, setSubmittedQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CredentialSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CredentialSummary | null>(null);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);

  const list = useQuery({
    queryKey: workbenchKeys.credentialList(shopId, { page, q: submittedQ }),
    queryFn: () =>
      api.get<PageResult<CredentialSummary>>(`/shops/${shopId}/credentials`, {
        query: { page, pageSize: PAGE_SIZE_DEFAULT, q: submittedQ || undefined },
      }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/shops/${shopId}/credentials/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workbench', 'credentials'] });
      void queryClient.invalidateQueries({ queryKey: ['workbench', 'shops'] });
    },
  });

  async function reveal(row: CredentialSummary, copy: boolean): Promise<void> {
    const token = await reauth.requestToken(copy ? '复制店铺密码前需要确认是你本人操作。' : undefined);
    if (!token) return;
    try {
      const result = await api.post<CredentialRevealResponse>(
        `/shops/${shopId}/credentials/${row.id}/reveal`,
        undefined,
        { reauthToken: token },
      );
      if (copy) {
        const ok = await copyToClipboard(result.password);
        if (!ok) {
          toast.error('复制失败');
          return;
        }
        toast.success('已复制,请尽快粘贴。明文不会保存在本地。');
        const auditToken = await reauth.requestToken('复制操作将写入审计日志,需要再次确认是你本人。');
        if (!auditToken) return;
        await api.post(`/shops/${shopId}/credentials/${row.id}/copy-audit`, undefined, { reauthToken: auditToken });
        return;
      }
      setRevealed({
        id: row.id,
        password: result.password,
        hideAt: Date.now() + result.expiresInSeconds * 1000,
      });
      window.setTimeout(() => {
        setRevealed((current) => (current?.id === row.id ? null : current));
      }, result.expiresInSeconds * 1000);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  const columns = useMemo<Array<Column<CredentialSummary>>>(
    () => [
      { key: 'purpose', header: '用途', render: (row) => row.purpose },
      { key: 'account', header: '账号', render: (row) => row.account },
      {
        key: 'password',
        header: '密码',
        render: (row) => (
          <span className="font-mono tracking-widest">
            {revealed?.id === row.id && Date.now() < revealed.hideAt ? revealed.password : row.passwordMask || PASSWORD_DISPLAY_MASK}
          </span>
        ),
      },
      {
        key: 'loginUrl',
        header: '登录页',
        hideOnMobile: true,
        render: (row) =>
          row.loginUrl ? (
            <a href={row.loginUrl} className="text-accent hover:underline" target="_blank" rel="noreferrer">
              打开
            </a>
          ) : (
            '—'
          ),
      },
      {
        key: 'updatedAt',
        header: '更新',
        hideOnMobile: true,
        render: (row) => formatDateTime(row.passwordUpdatedAt),
      },
      {
        key: 'actions',
        header: '',
        render: (row) => (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={revealed?.id === row.id ? '隐藏密码' : '查看密码'}
              onClick={() => {
                if (revealed?.id === row.id) setRevealed(null);
                else void reveal(row, false);
              }}
            >
              {revealed?.id === row.id ? <EyeOff size={14} /> : <Eye size={14} />}
            </Button>
            <Button variant="ghost" size="icon" aria-label="复制密码" onClick={() => void reveal(row, true)}>
              <Copy size={14} />
            </Button>
            <Button variant="ghost" size="icon" aria-label="编辑凭据" onClick={() => setEditing(row)}>
              <Pencil size={14} />
            </Button>
            <Button variant="ghost" size="icon" aria-label="删除凭据" onClick={() => setDeleteTarget(row)}>
              <Trash2 size={14} />
            </Button>
          </div>
        ),
      },
    ],
    [revealed, shopId],
  );

  const shopName = shops.find((item) => item.id === shopId)?.name;

  return (
    <>
      {reauth.dialog}
      <InlineAlert tone="warning">
        明文只短暂显示在当前页面,不会写入查询缓存或本地存储。每次查看、每次复制都要重新验证。
      </InlineAlert>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setSubmittedQ(q.trim());
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索用途、账号或备注" className="pl-9" />
        </div>
        <Button type="submit">搜索</Button>
        <Button type="button" iconLeft={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
          新增
        </Button>
      </form>

      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={list.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={list.isPending}
            emptyMessage={<EmptyState title={shopName ? `${shopName} 还没有凭据` : '还没有凭据'} />}
          />
          {list.data ? (
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPageChange={setPage} />
          ) : null}
        </>
      )}

      <CredentialFormDialog
        open={createOpen || Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditing(null);
          }
        }}
        shopId={shopId}
        editing={editing}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['workbench', 'credentials'] });
          void queryClient.invalidateQueries({ queryKey: ['workbench', 'shops'] });
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        theme="dark"
        danger
        title="删除凭据"
        description={deleteTarget ? `将删除「${deleteTarget.purpose} / ${deleteTarget.account}」。此操作不可撤销。` : undefined}
        confirmLabel="删除"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await remove.mutateAsync(deleteTarget.id);
          toast.success('凭据已删除');
          setDeleteTarget(null);
        }}
      />
    </>
  );
}

function CredentialFormDialog({
  open,
  onOpenChange,
  shopId,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string;
  editing: CredentialSummary | null;
  onSaved: () => void;
}): React.JSX.Element {
  const [purpose, setPurpose] = useState('');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPurpose(editing?.purpose ?? '');
    setAccount(editing?.account ?? '');
    setLoginUrl(editing?.loginUrl ?? '');
    setNote(editing?.note ?? '');
    setPassword('');
    setFieldErrors({});
  }, [open, editing]);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setFieldErrors({});
    try {
      if (editing) {
        await api.patch(`/shops/${shopId}/credentials/${editing.id}`, {
          purpose,
          account,
          password: password || undefined,
          loginUrl: loginUrl || null,
          note: note || null,
        });
      } else {
        const body: CredentialCreateInput = {
          purpose,
          account,
          password,
          loginUrl: loginUrl || null,
          note: note || null,
        };
        await api.post(`/shops/${shopId}/credentials`, body);
      }
      toast.success('凭据已保存');
      setPurpose('');
      setAccount('');
      setPassword('');
      setLoginUrl('');
      setNote('');
      onOpenChange(false);
      onSaved();
    } catch (error) {
      setFieldErrors(fieldErrorsFromApi(error));
      toast.error(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPurpose('');
          setAccount('');
          setPassword('');
          setLoginUrl('');
          setNote('');
          setFieldErrors({});
        }
        onOpenChange(next);
      }}
      theme="dark"
      title={editing ? '编辑凭据' : '新增凭据'}
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
      <div className="space-y-3">
        <Field label="用途" htmlFor="cred-purpose" required error={fieldErrors.purpose}>
          <Input id="cred-purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
        </Field>
        <Field label="账号" htmlFor="cred-account" required error={fieldErrors.account}>
          <Input id="cred-account" value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="off" />
        </Field>
        <Field
          label="密码"
          htmlFor="cred-password"
          required={!editing}
          error={fieldErrors.password}
          description={editing ? '留空表示不修改密码' : undefined}
        >
          <Input
            id="cred-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label="登录网址" htmlFor="cred-url" error={fieldErrors.loginUrl}>
          <Input id="cred-url" value={loginUrl} onChange={(event) => setLoginUrl(event.target.value)} />
        </Field>
        <Field label="备注" htmlFor="cred-note">
          <Textarea id="cred-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
