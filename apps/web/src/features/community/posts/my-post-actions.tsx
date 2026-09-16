'use client';

import type { PostListItem } from '@june/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api/errors';

import { communityKeys, deleteDraft, deletePost, publishDraft } from '../api';
import { postDetailPath, postEditPath } from '../utils';

/** 我的内容 / 草稿列表卡片上的编辑、发布、删除。 */
export function MyPostActions({ post }: { post: PostListItem }): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<'publish' | 'delete' | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: communityKeys.all });
  };

  const isDraft = post.status === 'DRAFT';
  const editHref = isDraft ? `/community/drafts/${encodeURIComponent(post.id)}` : postEditPath(post.slug);

  const onPublish = async (): Promise<void> => {
    setBusy('publish');
    try {
      const published = await publishDraft(post.id);
      toast.success('已发布');
      invalidate();
      router.push(postDetailPath(published.slug));
      router.refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (): Promise<void> => {
    setBusy('delete');
    try {
      if (isDraft) await deleteDraft(post.id);
      else await deletePost(post.id);
      toast.success('已删除');
      invalidate();
      setConfirmOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" asChild iconLeft={<Pencil size={14} />}>
        <Link href={editHref}>{isDraft ? '继续编辑' : '编辑'}</Link>
      </Button>
      {isDraft ? (
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Send size={14} />}
          loading={busy === 'publish'}
          onClick={() => void onPublish()}
        >
          发布
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="text-state-danger-fg"
        iconLeft={<Trash2 size={14} />}
        onClick={() => setConfirmOpen(true)}
      >
        删除
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={isDraft ? '删除这份草稿?' : '删除这篇内容?'}
        description={
          isDraft
            ? '删除后无法恢复。公开链接尚未生成,不影响已发布内容。'
            : '删除后内容将从社区下架,公开链接也会失效。此操作不可撤销。'
        }
        confirmLabel="删除"
        danger
        loading={busy === 'delete'}
        onConfirm={onDelete}
        theme="light"
      />
    </>
  );
}
