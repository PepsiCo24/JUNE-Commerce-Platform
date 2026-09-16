'use client';

import { COMMENT_MAX, commentCreateSchema, type CommentItem } from '@june/shared';
import { MessageSquare, Reply, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/states';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { CharCounter, Textarea } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/pagination';
import { describeError } from '@/lib/api/errors';
import { formatRelativeTime } from '@/lib/utils';
import { useAuth } from '@/providers/auth-provider';

import { useComments } from '../hooks/use-comments';

/**
 * 评论区。顶级评论游标分页,回复由后端挂在父评论下一次带回。
 * 只支持一级回复;点嵌套评论的「回复」仍回复原评论。
 */
export function CommentThread({ postId }: { postId: string }): React.JSX.Element {
  const comments = useComments(postId);
  const { isAuthenticated } = useAuth();
  const router = useRouter();

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const login = (): void => {
    toast.info('请先登录后再评论');
    router.push(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
  };

  const submit = async (): Promise<void> => {
    if (!isAuthenticated) {
      login();
      return;
    }

    const parsed = commentCreateSchema.safeParse({
      content: draft,
      parentId: replyTo?.id ?? null,
    });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? '评论内容不符合要求');
      return;
    }

    try {
      await comments.submit({
        content: parsed.data.content,
        parentId: parsed.data.parentId,
      });
      setDraft('');
      setReplyTo(null);
      toast.success(replyTo ? '回复已发布' : '评论已发布');
    } catch (error) {
      toast.error(describeError(error));
    }
  };

  const remove = async (commentId: string): Promise<void> => {
    try {
      await comments.remove(commentId);
      toast.success('评论已删除');
      setPendingId(null);
    } catch (error) {
      toast.error(describeError(error));
    }
  };

  return (
    <section aria-labelledby="comments-heading" className="flex flex-col gap-5">
      <h2 id="comments-heading" className="text-lg font-semibold text-fg">
        评论
      </h2>

      <CommentComposer
        value={draft}
        onChange={setDraft}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        submitting={comments.submitting}
        onSubmit={() => void submit()}
        isAuthenticated={isAuthenticated}
        onRequireLogin={login}
      />

      {comments.isLoading ? <LoadingState message="正在加载评论" /> : null}

      {!comments.isLoading && comments.isError ? (
        <ErrorState error={comments.error} onRetry={comments.refetch} title="评论加载失败" />
      ) : null}

      {!comments.isLoading && !comments.isError && comments.items.length === 0 ? (
        <EmptyState
          icon={<MessageSquare size={22} />}
          title="还没有评论"
          description="成为第一个留言的人。"
        />
      ) : null}

      {!comments.isLoading && !comments.isError && comments.items.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {comments.items.map((item) => (
            <li key={item.id}>
              <CommentItemView
                item={item}
                onReply={(target) => {
                  setReplyTo(target);
                  setDraft('');
                }}
                onDelete={(id) => setPendingId(id)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {!comments.isLoading && !comments.isError && comments.items.length > 0 ? (
        <LoadMore
          hasMore={comments.hasMore}
          loading={comments.isFetchingNextPage}
          onLoadMore={comments.loadMore}
        />
      ) : null}

      <ConfirmDialog
        open={pendingId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingId(null);
        }}
        title="删除这条评论?"
        description="删除后不可恢复。"
        confirmLabel="删除"
        danger
        loading={comments.removing}
        onConfirm={() => {
          if (pendingId) void remove(pendingId);
        }}
        theme="light"
      />
    </section>
  );
}

function CommentComposer({
  value,
  onChange,
  replyTo,
  onCancelReply,
  submitting,
  onSubmit,
  isAuthenticated,
  onRequireLogin,
}: {
  value: string;
  onChange: (value: string) => void;
  replyTo: { id: string; name: string } | null;
  onCancelReply: () => void;
  submitting: boolean;
  onSubmit: () => void;
  isAuthenticated: boolean;
  onRequireLogin: () => void;
}): React.JSX.Element {
  const disabled = submitting || value.trim().length === 0;

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border-default bg-surface p-3 sm:p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!isAuthenticated) {
          onRequireLogin();
          return;
        }
        onSubmit();
      }}
    >
      {replyTo ? (
        <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
          <span>
            回复 <span className="text-fg">{replyTo.name}</span>
          </span>
          <button type="button" className="hover:text-fg" onClick={onCancelReply}>
            取消回复
          </button>
        </div>
      ) : null}

      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={isAuthenticated ? (replyTo ? `回复 ${replyTo.name}` : '写下你的评论') : '登录后即可发表评论'}
        rows={3}
        autoGrow
        maxLength={COMMENT_MAX}
        aria-label="评论内容"
        disabled={!isAuthenticated || submitting}
      />

      <div className="flex items-center justify-between gap-3">
        <CharCounter value={value} max={COMMENT_MAX} />
        <Button type="submit" size="sm" loading={submitting} disabled={disabled && isAuthenticated}>
          {replyTo ? '发布回复' : '发表评论'}
        </Button>
      </div>
    </form>
  );
}

function CommentItemView({
  item,
  onReply,
  onDelete,
}: {
  item: CommentItem;
  onReply: (target: { id: string; name: string }) => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const replies = item.replies ?? [];
  const replyTargetId = item.parentId ?? item.id;
  const visible = item.status === 'VISIBLE';

  return (
    <article className="flex gap-3">
      <Avatar src={item.author.avatarUrl} name={item.author.displayName} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="text-sm font-medium text-fg">{item.author.displayName}</p>
          <time className="text-xs text-fg-subtle" dateTime={item.createdAt}>
            {formatRelativeTime(item.createdAt)}
          </time>
        </div>
        {visible && item.replyToName ? (
          <p className="mt-0.5 text-xs text-fg-subtle">
            回复 <span className="text-fg-muted">{item.replyToName}</span>
          </p>
        ) : null}
        {visible ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">{item.content}</p>
        ) : (
          <p className="mt-1 text-sm text-fg-muted">该评论已删除</p>
        )}
        {visible ? (
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<Reply size={14} />}
              onClick={() => onReply({ id: replyTargetId, name: item.author.displayName })}
            >
              回复
            </Button>
            {item.canDelete ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-state-danger-fg"
                iconLeft={<Trash2 size={14} />}
                onClick={() => onDelete(item.id)}
              >
                删除
              </Button>
            ) : null}
          </div>
        ) : null}

        {replies.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-3 border-l border-border-default pl-4">
            {replies.map((reply) => (
              <li key={reply.id}>
                <CommentItemView item={reply} onReply={onReply} onDelete={onDelete} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
