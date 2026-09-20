'use client';

import { POST_CATEGORY_LABELS, type PostListItem } from '@june/shared';
import { Flame, Heart, Lightbulb, MessageSquare, PenLine } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCount } from '@/lib/utils';

import { usePostList } from '../hooks/use-post-list';
import { postDetailPath } from '../utils';

const TIPS = [
  '标题写清场景,更容易被搜到',
  '晒单记得带图与结果对比',
  '提问类帖子补充平台与版本',
] as const;

/**
 * 右侧栏:热帖速览 + 发帖提示。
 * 外层 sticky 吸顶;内容按自然高度堆叠。
 */
export function CommunityAside(): React.JSX.Element {
  const hot = usePostList({ sort: 'hot' });

  const hotItems = useMemo(() => {
    const merged = [...hot.pinned, ...hot.normal];
    const seen = new Set<string>();
    const unique: PostListItem[] = [];
    for (const post of merged) {
      if (seen.has(post.id) || post.unavailable) continue;
      seen.add(post.id);
      unique.push(post);
      if (unique.length >= 5) break;
    }
    return unique;
  }, [hot.pinned, hot.normal]);

  return (
    <aside className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-2xl border border-border-default bg-bg-elevated/90 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2 border-b border-border-default px-3.5 py-3">
          <Flame size={14} className="text-accent" aria-hidden />
          <p className="text-sm font-medium text-fg">热门速览</p>
        </div>

        {hot.isLoading ? (
          <div className="flex flex-col gap-3 p-3.5">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : hotItems.length === 0 ? (
          <p className="px-3.5 py-4 text-sm text-fg-muted">还没有热帖,来发第一篇吧。</p>
        ) : (
          <ol className="flex flex-col divide-y divide-border-default">
            {hotItems.map((post, index) => (
              <li key={post.id}>
                <Link
                  href={postDetailPath(post.slug)}
                  className="flex gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-surface-hover"
                >
                  <span className="mt-0.5 w-4 shrink-0 text-xs font-semibold text-fg-subtle tabular">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm font-medium text-fg">{post.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-subtle">
                      <span>{POST_CATEGORY_LABELS[post.category]}</span>
                      <span className="inline-flex items-center gap-0.5">
                        <Heart size={11} aria-hidden />
                        {formatCount(post.likeCount)}
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <MessageSquare size={11} aria-hidden />
                        {formatCount(post.commentCount)}
                      </span>
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}

        <div className="border-t border-border-default p-2.5">
          <Link
            href="/community?sort=hot"
            className="block rounded-lg px-2.5 py-1.5 text-center text-xs text-accent hover:bg-accent-surface"
          >
            查看更多热门
          </Link>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border-default bg-bg-elevated/90 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2 border-b border-border-default px-3.5 py-3">
          <Lightbulb size={14} className="text-accent" aria-hidden />
          <p className="text-sm font-medium text-fg">发帖小贴士</p>
        </div>
        <ul className="flex flex-col gap-2 px-3.5 py-3 text-xs leading-relaxed text-fg-muted">
          {TIPS.map((tip) => (
            <li key={tip} className="flex gap-2">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent/70" aria-hidden />
              <span>{tip}</span>
            </li>
          ))}
        </ul>
        <div className="border-t border-border-default p-2.5">
          <Button asChild variant="secondary" size="sm" fullWidth iconLeft={<PenLine size={14} />}>
            <Link href="/community/posts/new">去发布</Link>
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-dashed border-border-default bg-bg-elevated/50 px-3.5 py-3 text-[11px] leading-relaxed text-fg-subtle">
        友善讨论 · 拒绝灌水 · 分享真实经验。违规内容可联系管理员处理。
      </div>
    </aside>
  );
}
