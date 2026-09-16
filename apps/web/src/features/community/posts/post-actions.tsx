'use client';

import type { PostDetail } from '@june/shared';
import { Bookmark, Heart, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api/errors';
import { formatCount } from '@/lib/utils';
import { useAuth } from '@/providers/auth-provider';

import { deleteDraft, deletePost } from '../api';
import { usePostBookmark } from '../hooks/use-post-bookmark';
import { usePostLike } from '../hooks/use-post-like';
import { SharePanel } from '../share/share-panel';
import { postEditPath } from '../utils';

/**
 * 详情页的操作区:点赞、收藏、分享、作者的编辑与删除。
 *
 * `canEdit` / `canDelete` 来自后端,这里只用来决定"要不要显示入口"。
 * 隐藏按钮只是体验优化 —— 真正的判定在后端,伪造请求依然会被拒绝。
 */
export function PostActions({ post }: { post: PostDetail }): React.JSX.Element {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const like = usePostLike({
    postId: post.id,
    initialLiked: post.likedByMe,
    initialCount: post.likeCount,
    onUnauthenticated: () => {
      toast.info('请先登录后再点赞');
      router.push(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
    },
  });

  const bookmark = usePostBookmark({
    postId: post.id,
    initialBookmarked: post.bookmarkedByMe,
    onUnauthenticated: () => {
      toast.info('请先登录后再收藏');
      router.push(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
    },
  });

  const onDelete = async (): Promise<void> => {
    setDeleting(true);
    try {
      // 草稿与已发布帖子是两个接口:草稿从未计入图片引用,后端处理方式不同
      if (post.status === 'DRAFT') await deleteDraft(post.id);
      else await deletePost(post.id);

      toast.success('已删除');
      setConfirmOpen(false);
      router.push('/community/mine');
      router.refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={like.liked ? 'primary' : 'outline'}
        size="sm"
        onClick={() => {
          if (!isAuthenticated) {
            toast.info('请先登录后再点赞');
            router.push(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
            return;
          }
          like.toggle();
        }}
        disabled={like.pending}
        iconLeft={<Heart size={16} className={like.liked ? 'fill-current' : undefined} />}
        aria-pressed={like.liked}
        aria-label={like.liked ? '取消点赞' : '点赞'}
      >
        <span className="tabular">{formatCount(like.count)}</span>
      </Button>

      <Button
        variant={bookmark.bookmarked ? 'primary' : 'outline'}
        size="sm"
        onClick={() => {
          if (!isAuthenticated) {
            toast.info('请先登录后再收藏');
            router.push(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
            return;
          }
          bookmark.toggle();
        }}
        disabled={bookmark.pending}
        iconLeft={
          <Bookmark size={16} className={bookmark.bookmarked ? 'fill-current' : undefined} />
        }
        aria-pressed={bookmark.bookmarked}
        aria-label={bookmark.bookmarked ? '取消收藏' : '收藏'}
      >
        {bookmark.bookmarked ? '已收藏' : '收藏'}
      </Button>

      {/* 只有已发布的帖子才有稳定公开链接,草稿与被隐藏的帖子不显示分享入口 */}
      {post.status === 'PUBLISHED' ? <SharePanel slug={post.slug} title={post.title} /> : null}

      {post.canEdit ? (
        <Button variant="ghost" size="sm" asChild iconLeft={<Pencil size={16} />}>
          <Link href={postEditPath(post.slug)}>编辑</Link>
        </Button>
      ) : null}

      {post.canDelete ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          iconLeft={<Trash2 size={16} />}
          className="text-state-danger-fg"
        >
          删除
        </Button>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="删除这篇内容?"
        description="删除后内容将从社区下架,公开链接也会失效。此操作不可撤销。"
        confirmLabel="删除"
        danger
        loading={deleting}
        onConfirm={onDelete}
        theme="light"
      />
    </div>
  );
}
