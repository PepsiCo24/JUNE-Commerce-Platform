'use client';

import type { PostListItem } from '@june/shared';
import { Bookmark, Heart, MessageSquare, Pin } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Avatar } from '@/components/ui/avatar';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { cn, formatCount, formatRelativeTime } from '@/lib/utils';
import { useAuth } from '@/providers/auth-provider';

import { usePostBookmark } from '../hooks/use-post-bookmark';
import { usePostLike } from '../hooks/use-post-like';
import { SharePanel } from '../share/share-panel';
import { postDetailPath } from '../utils';

/**
 * 横向紧凑帖子卡片。
 *
 * 无封面时不占位空白块;封面加载失败则隐藏缩略图。
 * 操作区各自 stopPropagation,避免与标题链接嵌套冲突。
 */
export function PostCard({
  post,
  pinned = false,
  showStatus = false,
  showShare = true,
  actions,
  className,
  animate = true,
}: {
  post: PostListItem;
  pinned?: boolean;
  showStatus?: boolean;
  showShare?: boolean;
  actions?: React.ReactNode;
  className?: string;
  /** 入场动画(仅首次挂载一次) */
  animate?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [thumbFailed, setThumbFailed] = useState(false);

  const unavailable = Boolean(post.unavailable);
  const cardHref = unavailable ? null : postDetailPath(post.slug);
  const showThumb = Boolean(post.coverUrl) && !thumbFailed && !unavailable;

  const requireAuth = (action: string): boolean => {
    if (isAuthenticated) return true;
    toast.info(`请先登录后再${action}`);
    router.push(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
    return false;
  };

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

  const titleText = unavailable ? '内容不可用' : post.title || '(无标题)';
  const timeLabel = post.bookmarkedAt
    ? `收藏于 ${formatRelativeTime(post.bookmarkedAt)}`
    : post.publishedAt
      ? formatRelativeTime(post.publishedAt)
      : '尚未发布';

  return (
    <article
      className={cn(
        'flex flex-col gap-3 rounded-xl border border-border-default bg-bg-elevated p-[18px] shadow-sm sm:p-5',
        pinned && 'border-accent-border',
        unavailable && 'opacity-90',
        animate && 'community-card-enter',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Link href={`/community/users/${post.author.id}`} className="shrink-0 rounded-full" onClick={(e) => e.stopPropagation()}>
          <Avatar src={post.author.avatarUrl} name={post.author.displayName} size={28} />
        </Link>
        <div className="min-w-0 flex-1">
          <Link
            href={`/community/users/${post.author.id}`}
            className="truncate text-sm text-fg hover:text-accent"
            onClick={(e) => e.stopPropagation()}
          >
            {post.author.displayName}
          </Link>
          <p className="text-xs text-fg-subtle">{timeLabel}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {pinned ? (
            <Badge tone="accent" size="sm" icon={<Pin size={12} />}>
              置顶
            </Badge>
          ) : null}
          {showStatus ? <StatusBadge status={post.status} /> : null}
          {unavailable ? (
            <Badge tone="neutral" size="sm">
              不可用
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[18px] leading-snug font-semibold text-fg sm:text-[19px]">
            {cardHref ? (
              <Link href={cardHref} className="hover:text-accent">
                {titleText}
              </Link>
            ) : (
              <span>{titleText}</span>
            )}
          </h3>

          {!unavailable && post.excerpt ? (
            <p className="mt-1.5 line-clamp-3 text-[14px] leading-relaxed text-fg-muted sm:text-[15px]">
              {post.excerpt}
            </p>
          ) : null}

          {unavailable ? (
            <p className="mt-1.5 text-sm text-fg-muted">该内容已下架或不可访问,仍可取消收藏。</p>
          ) : null}
        </div>

        {showThumb ? (
          cardHref ? (
            <Link
              href={cardHref}
              className="relative h-24 w-36 shrink-0 overflow-hidden rounded-md bg-surface-hover sm:h-[72px] sm:w-24"
              aria-label={`查看帖子:《${post.title}》`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- 列表缩略图需 onError 隐藏,不走 AssetImage */}
              <img
                src={post.coverUrl!}
                alt=""
                className="size-full object-cover"
                loading="lazy"
                onError={() => setThumbFailed(true)}
              />
            </Link>
          ) : (
            <div className="relative h-24 w-36 shrink-0 overflow-hidden rounded-md bg-surface-hover sm:h-[72px] sm:w-24">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={post.coverUrl!}
                alt=""
                className="size-full object-cover"
                loading="lazy"
                onError={() => setThumbFailed(true)}
              />
            </div>
          )
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t border-border-default pt-3">
        {!unavailable ? (
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg',
              like.liked && 'text-accent',
            )}
            aria-pressed={like.liked}
            aria-label={like.liked ? '取消点赞' : '点赞'}
            disabled={like.pending}
            onClick={(event) => {
              event.stopPropagation();
              if (!requireAuth('点赞')) return;
              like.toggle();
            }}
          >
            <Heart size={14} className={like.liked ? 'fill-current' : undefined} aria-hidden />
            <span className="tabular">{formatCount(like.count)}</span>
          </button>
        ) : null}

        {!unavailable && cardHref ? (
          <Link
            href={cardHref}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label={`${post.commentCount} 条评论`}
            onClick={(event) => event.stopPropagation()}
          >
            <MessageSquare size={14} aria-hidden />
            <span className="tabular">{formatCount(post.commentCount)}</span>
          </Link>
        ) : null}

        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg',
            bookmark.bookmarked && 'text-accent',
          )}
          aria-pressed={bookmark.bookmarked}
          aria-label={bookmark.bookmarked ? '取消收藏' : '收藏'}
          disabled={bookmark.pending}
          onClick={(event) => {
            event.stopPropagation();
            if (!requireAuth('收藏')) return;
            bookmark.toggle();
          }}
        >
          <Bookmark
            size={14}
            className={bookmark.bookmarked ? 'fill-current' : undefined}
            aria-hidden
          />
          <span className="sr-only sm:not-sr-only sm:inline">
            {bookmark.bookmarked ? '已收藏' : '收藏'}
          </span>
        </button>

        {!unavailable && showShare && post.status === 'PUBLISHED' ? (
          <span
            className="inline-flex"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <SharePanel slug={post.slug} title={post.title} compact />
          </span>
        ) : null}

        {actions ? <div className="ml-auto flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </article>
  );
}
