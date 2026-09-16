'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AdminPostView } from '@/features/admin/api/types';
import { useActionConfirm } from '@/features/admin/hooks/use-action-confirm';
import { fieldErrorsOf, toastApiError } from '@/features/admin/lib/errors';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { formatDateTime } from '@/lib/utils';

export function PostDetailScreen({ postId: id }: { postId: string }): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { confirm, confirmNode } = useActionConfirm();
  const [title, setTitle] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [contentHtml, setContentHtml] = useState('');
  const [reason, setReason] = useState('');
  const [pinOrder, setPinOrder] = useState('0');

  const query = useQuery({
    queryKey: adminKeys.post(id),
    queryFn: ({ signal }) => adminApi.get<AdminPostView>(ADMIN_PATHS.content.post(id), { signal }),
  });

  useEffect(() => {
    if (!query.data) return;
    setTitle(query.data.title);
    setExcerpt(query.data.excerpt ?? '');
    setContentHtml(query.data.contentHtml);
    setPinOrder(String(query.data.pinnedOrder ?? 0));
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      adminApi.patch<AdminPostView>(ADMIN_PATHS.content.post(id), {
        title,
        excerpt: excerpt || null,
        contentHtml,
        reason: reason || undefined,
      }),
    onSuccess: () => {
      toast.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'content'] });
    },
    onError: (error) => toastApiError(error, '保存失败'),
  });

  const visibility = useMutation({
    mutationFn: (action: 'hide' | 'restore' | 'delete') =>
      adminApi.post<AdminPostView>(ADMIN_PATHS.content.postVisibility(id), { action, reason: reason || undefined }),
    onSuccess: () => {
      toast.success('已更新可见性');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'content'] });
      void query.refetch();
    },
    onError: (error) => toastApiError(error, '无法更新可见性'),
  });

  const pin = useMutation({
    mutationFn: (pinned: boolean) =>
      adminApi.post<AdminPostView>(ADMIN_PATHS.content.postPin(id), {
        pinned,
        order: Number(pinOrder) || 0,
      }),
    onSuccess: () => {
      toast.success('已更新置顶');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'content'] });
      void query.refetch();
    },
    onError: (error) => toastApiError(error, '无法更新置顶'),
  });

  if (query.isPending) return <LoadingState message="加载帖子" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const post = query.data;
  const fieldErrors = fieldErrorsOf(save.error);

  return (
    <div className="space-y-6">
      {confirmNode}
      <PageHeader
        title={post.title}
        description={`${post.authorName} · ${post.authorEmail}`}
        breadcrumbs={[
          { label: '帖子', href: '/admin/posts' },
          { label: post.title },
        ]}
        actions={<StatusBadge status={post.status} />}
      />

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>slug:{' '}
          <code className="text-fg-muted">{post.slug}</code>
        </div>
        <div>更新 {formatDateTime(post.updatedAt)}</div>
        <div>发布 {formatDateTime(post.publishedAt)}</div>
        <div>隐藏原因 {post.hiddenReason ?? '—'}</div>
      </dl>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="标题" htmlFor="post-title" required error={fieldErrors.title}>
          <Input id="post-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="摘要" htmlFor="post-excerpt" error={fieldErrors.excerpt}>
          <Input id="post-excerpt" value={excerpt} onChange={(event) => setExcerpt(event.target.value)} />
        </Field>
        <Field label="正文 HTML" htmlFor="post-html" error={fieldErrors.contentHtml}>
          <Textarea
            id="post-html"
            rows={12}
            value={contentHtml}
            onChange={(event) => setContentHtml(event.target.value)}
          />
        </Field>
        <Field label="修改原因(写入审计)" htmlFor="post-reason">
          <Input id="post-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={save.isPending}>
            保存编辑
          </Button>
          {post.status !== 'HIDDEN' && post.status !== 'DELETED' ? (
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                const ok = await confirm({ title: '隐藏这篇帖子?', danger: true, confirmLabel: '隐藏' });
                if (ok) visibility.mutate('hide');
              }}
            >
              隐藏
            </Button>
          ) : (
            <Button type="button" variant="secondary" onClick={() => visibility.mutate('restore')}>
              恢复
            </Button>
          )}
          <Button
            type="button"
            variant="danger"
            onClick={async () => {
              const ok = await confirm({
                title: '删除这篇帖子?',
                description: '软删除。公开链接将不可访问。',
                danger: true,
                requireText: post.slug,
                confirmLabel: '删除',
              });
              if (ok) visibility.mutate('delete');
            }}
          >
            删除
          </Button>
        </div>
      </form>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border-default bg-surface p-4">
        <Field label="置顶顺序" htmlFor="pin-order" description="数值越小越靠前">
          <Input id="pin-order" type="number" min={0} max={9999} value={pinOrder} onChange={(event) => setPinOrder(event.target.value)} className="w-28" />
        </Field>
        <Button type="button" variant="secondary" loading={pin.isPending} onClick={() => pin.mutate(true)}>
          {post.isPinned ? '更新顺序' : '置顶'}
        </Button>
        {post.isPinned ? (
          <Button type="button" variant="ghost" onClick={() => pin.mutate(false)}>
            取消置顶
          </Button>
        ) : null}
        <Button type="button" variant="link" onClick={() => router.push('/admin/posts')}>
          返回列表
        </Button>
      </div>
    </div>
  );
}
