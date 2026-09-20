'use client';

import type { PostDetail } from '@june/shared';
import { POST_CATEGORY_LABELS } from '@june/shared';
import { EyeOff, FileClock } from 'lucide-react';
import Link from 'next/link';

import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { AssetImage } from '@/components/media/asset-image';
import { formatCount, formatRelativeTime } from '@/lib/utils';

import { CommentThread } from '../comments/comment-thread';
import { usePostDetailSync } from '../hooks/use-community-sse';
import { PostActions } from './post-actions';
import { PostContent } from './post-content';
import { PostToc } from './post-toc';

/**
 * 帖子详情的客户端包装:点赞、分享、评论,以及管理员隐藏/删除后的 SSE 刷新。
 * 正文本身由服务端取数后传入,可见性每次请求由后端重新判定。
 */
export function PostDetailView({ post }: { post: PostDetail }): React.JSX.Element {
  usePostDetailSync({ postId: post.id, slug: post.slug });

  const cover = post.coverUrl
    ? {
        id: `${post.id}-cover`,
        url: post.coverUrl,
        thumbUrl: post.coverUrl,
        previewUrl: post.coverUrl,
        width: post.coverWidth,
        height: post.coverHeight,
      }
    : null;

  return (
    <article className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:items-start lg:gap-10">
      <PostToc contentHtml={post.contentHtml} variant="sidebar" />
      <div className="min-w-0 flex-1 flex max-w-[820px] flex-col gap-6 lg:mx-auto">
        <PostToc contentHtml={post.contentHtml} variant="mobile" />
      {post.status === 'DRAFT' ? (
        <p className="flex items-center gap-2 rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-fg-muted">
          <FileClock size={16} aria-hidden />
          这是草稿预览,仅你自己可见,公开链接在发布后才会生效。
        </p>
      ) : null}
      {post.status === 'HIDDEN' ? (
        <p className="flex items-center gap-2 rounded-md border border-state-warning-border bg-state-warning-bg px-3 py-2 text-sm text-state-warning-fg">
          <EyeOff size={16} aria-hidden />
          该内容已被管理员隐藏,仅作者可见。
        </p>
      ) : null}

      {cover ? (
        <AssetImage
          asset={cover}
          variant="preview"
          alt={`《${post.title}》的封面`}
          aspect={post.coverWidth && post.coverHeight ? undefined : '16/9'}
          sizes="(max-width: 768px) 100vw, 48rem"
          priority
          className="w-full overflow-hidden rounded-lg"
        />
      ) : null}

      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-surface-hover px-2.5 py-1 text-xs text-fg-muted">
            {POST_CATEGORY_LABELS[post.category]}
          </span>
          {post.isPinned ? (
            <Badge tone="accent" size="sm">
              置顶
            </Badge>
          ) : null}
        </div>
        <h1 className="text-2xl font-semibold text-fg sm:text-3xl">{post.title}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/community/users/${post.author.id}`}>
            <Avatar src={post.author.avatarUrl} name={post.author.displayName} size={40} />
          </Link>
          <div className="min-w-0">
            <Link href={`/community/users/${post.author.id}`} className="text-sm font-medium text-fg hover:text-accent">
              {post.author.displayName}
            </Link>
            <p className="text-xs text-fg-subtle">
              {post.publishedAt ? `${formatRelativeTime(post.publishedAt)}发布` : '尚未发布'}
              {post.contentEditedAt ? ` · ${formatRelativeTime(post.contentEditedAt)}编辑` : ''}
              {post.status === 'PUBLISHED' ? ` · ${formatCount(post.viewCount)} 次浏览` : ''}
            </p>
          </div>
        </div>
      </header>

      <PostContent contentHtml={post.contentHtml} images={post.images} title={post.title} />

      <PostActions post={post} />

      {post.status === 'PUBLISHED' ? (
        <CommentThread postId={post.id} />
      ) : (
        <p className="text-sm text-fg-muted">发布之后才能评论。</p>
      )}
      </div>
    </article>
  );
}
