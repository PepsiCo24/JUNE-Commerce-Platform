'use client';

import {
  POST_CATEGORY_LABELS,
  type PostCategory,
  type PostListItem,
} from '@june/shared';
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
 * 紧凑信息流卡片(参考 Reddit / X Communities 密度)。
 * 单行元信息 + 标题/摘要 + 小缩略图 + 底栏互动。
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
  animate?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [thumbFailed, setThumbFailed] = useState(false);

  const unavailable = Boolean(post.unavailable);
  const cardHref = unavailable ? null : postDetailPath(post.slug);
  const showThumb = Boolean(post.coverUrl) && !thumbFailed && !unavailable;
  const category = (post.category ?? 'other') as PostCategory;

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
        'rounded-lg border border-border-default bg-bg-elevated px-3 py-2 transition-colors hover:border-border-strong',
        pinned && 'border-accent-border bg-accent-surface/30',
        unavailable && 'opacity-90',
        animate && 'community-card-enter',
        className,
      )}
    >
      <div className="flex gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-fg-subtle">
            <Link
              href={`/community/users/${post.author.id}`}
              className="inline-flex max-w-[40%] items-center gap-1 truncate text-fg hover:text-accent"
              onClick={(e) => e.stopPropagation()}
            >
              <Avatar src={post.author.avatarUrl} name={post.author.displayName} size={16} />
              <span className="truncate font-medium">{post.author.displayName}</span>
            </Link>
            <span aria-hidden>·</span>
            <span className="rounded bg-surface-hover px-1 py-px text-[10px] text-fg-muted">
              {POST_CATEGORY_LABELS[category]}
            </span>
            <span aria-hidden>·</span>
            <time className="tabular">{timeLabel}</time>
            {pinned ? (
              <Badge tone="accent" size="sm" icon={<Pin size={11} />}>
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

          <h3 className="mt-0.5 line-clamp-1 text-sm leading-snug font-semibold text-fg sm:text-[15px]">
            {cardHref ? (
              <Link href={cardHref} className="hover:text-accent">
                {titleText}
              </Link>
            ) : (
              <span>{titleText}</span>
            )}
          </h3>

          {!unavailable && post.excerpt ? (
            <p className="mt-0.5 line-clamp-1 text-xs leading-relaxed text-fg-muted">{post.excerpt}</p>
          ) : null}

          {unavailable ? (
            <p className="mt-0.5 text-xs text-fg-muted">该内容已下架或不可访问,仍可取消收藏。</p>
          ) : null}

          <div className="mt-1 flex flex-wrap items-center gap-0.5">
            {!unavailable ? (
              <button
                type="button"
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg',
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
                <Heart size={13} className={like.liked ? 'fill-current' : undefined} aria-hidden />
                <span className="tabular">{formatCount(like.count)}</span>
              </button>
            ) : null}

            {!unavailable && cardHref ? (
              <Link
                href={cardHref}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg"
                aria-label={`${post.commentCount} 条评论`}
                onClick={(event) => event.stopPropagation()}
              >
                <MessageSquare size={13} aria-hidden />
                <span className="tabular">{formatCount(post.commentCount)}</span>
              </Link>
            ) : null}

            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg',
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
                size={13}
                className={bookmark.bookmarked ? 'fill-current' : undefined}
                aria-hidden
              />
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
        </div>

        {showThumb ? (
          cardHref ? (
            <Link
              href={cardHref}
              className="relative size-14 shrink-0 overflow-hidden rounded-md bg-surface-hover"
              aria-label={`查看帖子:《${post.title}》`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={post.coverUrl!}
                alt=""
                className="size-full object-cover"
                loading="lazy"
                decoding="async"
                onError={() => setThumbFailed(true)}
              />
            </Link>
          ) : (
            <div className="relative size-14 shrink-0 overflow-hidden rounded-md bg-surface-hover">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={post.coverUrl!}
                alt=""
                className="size-full object-cover"
                loading="lazy"
                decoding="async"
                onError={() => setThumbFailed(true)}
              />
            </div>
          )
        ) : null}
      </div>
    </article>
  );
}
