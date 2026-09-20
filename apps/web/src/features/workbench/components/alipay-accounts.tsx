'use client';

import {
  ALIPAY_ACCOUNT_NAME_MAX,
  ALIPAY_PHONE_MAX,
  PAGE_SIZE_DEFAULT,
  PASSWORD_DISPLAY_MASK,
  alipayAccountCreateSchema,
  alipayAccountUpdateSchema,
  type AlipayAccountCreateInput,
  type AlipayAccountSummary,
  type AlipayAccountUpdateInput,
  type AlipayPasswordRevealResponse,
  type AlipayPhoneRevealResponse,
  type PageResult,
} from '@june/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, Pencil, Phone, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { CharCounter, Field, Input, Textarea } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/toggle';
import type { Column } from '@/components/ui/table';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { describeError } from '@/lib/api/errors';
import { copyToClipboard, formatDateTime } from '@/lib/utils';

import { useShopOptions } from '../hooks/use-options';
import { useReauth } from '../hooks/use-reauth';
import { fieldErrorsFromApi, fieldErrorsFromZod } from '../lib/form';
import { workbenchKeys } from '../lib/keys';

import { InlineAlert } from './inline-alert';

interface RevealedPassword {
  id: string;
  password: string;
  hideAt: number;
}

interface RevealedPhone {
  id: string;
  phone: string;
}

export function AlipayAccountsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const shops = useShopOptions();
  const reauth = useReauth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [submittedQ, setSubmittedQ] = useState('');
  const [shopFilter, setShopFilter] = useState<string>('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AlipayAccountSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AlipayAccountSummary | null>(null);
  const [revealedPassword, setRevealedPassword] = useState<RevealedPassword | null>(null);
  const [revealedPhone, setRevealedPhone] = useState<RevealedPhone | null>(null);

  const list = useQuery({
    queryKey: workbenchKeys.alipayList({
      page,
      q: submittedQ,
      shopId: shopFilter === 'ALL' ? undefined : shopFilter,
    }),
    queryFn: () =>
      api.get<PageResult<AlipayAccountSummary>>('/alipay-accounts', {
        query: {
          page,
          pageSize: PAGE_SIZE_DEFAULT,
          q: submittedQ || undefined,
          shopId: shopFilter === 'ALL' ? undefined : shopFilter,
        },
      }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/alipay-accounts/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workbench', 'alipay'] });
    },
  });

  async function revealPhone(row: AlipayAccountSummary): Promise<void> {
    const token = await reauth.requestToken('查看完整手机号前需要确认是你本人操作。');
    if (!token) return;
    try {
      const result = await api.post<AlipayPhoneRevealResponse>(
        `/alipay-accounts/${row.id}/reveal-phone`,
        undefined,
        { reauthToken: token },
      );
      setRevealedPhone({ id: row.id, phone: result.phone });
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function revealPassword(row: AlipayAccountSummary, copy: boolean): Promise<void> {
    if (!row.hasPassword) {
      toast.error('该账户尚未设置登录密码');
      return;
    }
    const token = await reauth.requestToken(copy ? '复制支付宝密码前需要确认是你本人操作。' : undefined);
    if (!token) return;
    try {
      const result = await api.post<AlipayPasswordRevealResponse>(
        `/alipay-accounts/${row.id}/reveal-password`,
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
        await api.post(`/alipay-accounts/${row.id}/copy-audit`, undefined, { reauthToken: auditToken });
        return;
      }
      setRevealedPassword({
        id: row.id,
        password: result.password,
        hideAt: Date.now() + result.expiresInSeconds * 1000,
      });
      window.setTimeout(() => {
        setRevealedPassword((current) => (current?.id === row.id ? null : current));
      }, result.expiresInSeconds * 1000);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  const columns = useMemo<Array<Column<AlipayAccountSummary>>>(
    () => [
      {
        key: 'name',
        header: '账户名称',
        render: (row) => (
          <div>
            <p className="font-medium text-fg">{row.name}</p>
            {row.shopName ? <p className="text-xs text-fg-subtle">关联 {row.shopName}</p> : null}
          </div>
        ),
      },
      {
        key: 'phone',
        header: '手机号',
        render: (row) => (
          <div className="flex items-center gap-1">
            <span className="font-mono text-sm">
              {revealedPhone?.id === row.id ? revealedPhone.phone : row.phoneMasked}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={revealedPhone?.id === row.id ? '隐藏手机号' : '查看手机号'}
              onClick={() => {
                if (revealedPhone?.id === row.id) setRevealedPhone(null);
                else void revealPhone(row);
              }}
            >
              {revealedPhone?.id === row.id ? <EyeOff size={14} /> : <Phone size={14} />}
            </Button>
          </div>
        ),
      },
      {
        key: 'password',
        header: '密码',
        render: (row) =>
          row.hasPassword ? (
            <span className="font-mono tracking-widest">
              {revealedPassword?.id === row.id && Date.now() < revealedPassword.hideAt
                ? revealedPassword.password
                : PASSWORD_DISPLAY_MASK}
            </span>
          ) : (
            <Badge tone="warning" size="sm">
              未设置
            </Badge>
          ),
      },
      {
        key: 'updatedAt',
        header: '更新',
        hideOnMobile: true,
        render: (row) => formatDateTime(row.updatedAt),
      },
      {
        key: 'actions',
        header: '',
        render: (row) => (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={revealedPassword?.id === row.id ? '隐藏密码' : '查看密码'}
              disabled={!row.hasPassword}
              onClick={() => {
                if (revealedPassword?.id === row.id) setRevealedPassword(null);
                else void revealPassword(row, false);
              }}
            >
              {revealedPassword?.id === row.id ? <EyeOff size={14} /> : <Eye size={14} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="复制密码"
              disabled={!row.hasPassword}
              onClick={() => void revealPassword(row, true)}
            >
              <Copy size={14} />
            </Button>
            <Button variant="ghost" size="icon" aria-label="编辑" onClick={() => setEditing(row)}>
              <Pencil size={14} />
            </Button>
            <Button variant="ghost" size="icon" aria-label="删除" onClick={() => setDeleteTarget(row)}>
              <Trash2 size={14} />
            </Button>
          </div>
        ),
      },
    ],
    [revealedPassword, revealedPhone],
  );

  return (
    <div className="space-y-4">
      {reauth.dialog}
      <PageHeader
        title="支付宝账户管理"
        description="信息管理 · 仅保存支付宝登录信息(账户名、手机号、密码),不含支付能力。查看明文需重新验证。"
        breadcrumbs={[
          { label: '工作台', href: '/workbench' },
          { label: '信息管理' },
          { label: '支付宝账户' },
        ]}
        actions={
          <Button iconLeft={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
            新增账户
          </Button>
        }
      />

      <InlineAlert tone="warning">
        手机号默认脱敏;密码默认掩码。查看或复制每次都要重新验证,明文不会写入缓存。
      </InlineAlert>

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setSubmittedQ(q.trim());
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索账户名、手机号或备注" className="pl-9" />
        </div>
        <Select
          aria-label="关联店铺"
          className="w-full shrink-0 sm:w-52"
          value={shopFilter}
          onChange={(value) => {
            setShopFilter(value);
            setPage(1);
          }}
          options={[
            { value: 'ALL', label: '全部店铺' },
            ...(shops.data ?? []).map((shop) => ({ value: shop.id, label: shop.name })),
          ]}
        />
        <Button type="submit" className="shrink-0">
          搜索
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
            emptyMessage={<EmptyState title="还没有支付宝账户" description="新增后可在此统一管理登录信息。" />}
          />
          {list.data ? (
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPageChange={setPage} />
          ) : null}
        </>
      )}

      <AlipayFormDialog
        open={createOpen || Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditing(null);
          }
        }}
        editing={editing}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['workbench', 'alipay'] });
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除支付宝账户"
        description={deleteTarget ? `确认删除「${deleteTarget.name}」？此操作不可恢复。` : ''}
        confirmLabel="删除"
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          void remove
            .mutateAsync(deleteTarget.id)
            .then(() => {
              toast.success('已删除');
              setDeleteTarget(null);
            })
            .catch((error: unknown) => toast.error(describeError(error)));
        }}
      />
    </div>
  );
}

function AlipayFormDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: AlipayAccountSummary | null;
  onSaved: () => void;
}): React.JSX.Element {
  const shops = useShopOptions();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [note, setNote] = useState('');
  const [shopId, setShopId] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // 打开时回填(密码从不回填)
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setPhone('');
    setPassword('');
    setClearPassword(false);
    setNote(editing?.note ?? '');
    setShopId(editing?.shopId ?? null);
    setFieldErrors({});
  }, [open, editing?.id, editing?.name, editing?.note, editing?.shopId, editing?.hasPassword, editing?.phoneMasked]);

  async function submit(): Promise<void> {
    setFieldErrors({});
    setSubmitting(true);
    try {
      if (editing) {
        const payload: AlipayAccountUpdateInput = {
          name,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          note: note || null,
          shopId,
          ...(clearPassword ? { clearPassword: true } : password ? { password } : {}),
        };
        const parsed = alipayAccountUpdateSchema.safeParse(payload);
        if (!parsed.success) {
          setFieldErrors(fieldErrorsFromZod(parsed.error));
          return;
        }
        await api.patch(`/alipay-accounts/${editing.id}`, parsed.data);
        toast.success('已更新');
      } else {
        const payload: AlipayAccountCreateInput = {
          name,
          phone: phone.trim(),
          password,
          note: note || null,
          shopId,
        };
        const parsed = alipayAccountCreateSchema.safeParse(payload);
        if (!parsed.success) {
          setFieldErrors(fieldErrorsFromZod(parsed.error));
          return;
        }
        await api.post('/alipay-accounts', parsed.data);
        toast.success('已创建');
      }
      onSaved();
      onOpenChange(false);
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
      onOpenChange={onOpenChange}
      title={editing ? '编辑支付宝账户' : '新增支付宝账户'}
      description="密码不会回填。编辑时留空表示保留原密码。"
    >
      <div className="space-y-3">
        <Field label="账户名称" htmlFor="alipay-name" required error={fieldErrors.name} addon={<CharCounter value={name} max={ALIPAY_ACCOUNT_NAME_MAX} />}>
          <Input id="alipay-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field
          label={editing ? '手机号(留空保留)' : '绑定手机号'}
          htmlFor="alipay-phone"
          required={!editing}
          error={fieldErrors.phone}
          description={editing ? `当前脱敏展示：${editing.phoneMasked}` : undefined}
          addon={<CharCounter value={phone} max={ALIPAY_PHONE_MAX} />}
        >
          <Input id="alipay-phone" value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" />
        </Field>
        <Field
          label={editing ? '登录密码(留空保留)' : '登录密码'}
          htmlFor="alipay-password"
          required={!editing}
          error={fieldErrors.password}
        >
          <Input
            id="alipay-password"
            type="password"
            value={password}
            disabled={clearPassword}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            placeholder={editing && editing.hasPassword ? PASSWORD_DISPLAY_MASK : undefined}
          />
        </Field>
        {editing && editing.hasPassword ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border-default px-3 py-2">
            <div>
              <p className="text-sm text-fg">清除密码</p>
              <p className="text-xs text-fg-muted">清除后需重新设置才能查看</p>
            </div>
            <Switch
              checked={clearPassword}
              onChange={(checked) => {
                setClearPassword(checked);
                if (checked) setPassword('');
              }}
              aria-label="清除密码"
            />
          </div>
        ) : null}
        <Field label="关联店铺(可选)" htmlFor="alipay-shop">
          <Select
            id="alipay-shop"
            value={shopId ?? '__none__'}
            onChange={(value) => setShopId(value === '__none__' ? null : value)}
            options={[
              { value: '__none__', label: '不关联' },
              ...(shops.data ?? []).map((shop) => ({ value: shop.id, label: shop.name })),
            ]}
          />
        </Field>
        <Field label="备注" htmlFor="alipay-note">
          <Textarea id="alipay-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={submitting} onClick={() => void submit()}>
            {editing ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
