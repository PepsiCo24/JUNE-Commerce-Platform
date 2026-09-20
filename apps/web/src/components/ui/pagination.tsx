'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';

/** 省略号占位,与真实页码区分 */
const GAP = 'gap';

/**
 * 生成带省略折叠的页码序列:1 … 4 5 6 … 20。
 * 总页数不多时全部列出,不做无意义的折叠。
 */
function buildPages(page: number, pageCount: number): Array<number | typeof GAP> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);

  const pages = new Set<number>([1, pageCount, page, page - 1, page + 1]);
  // 首尾附近多留一位,避免出现"1 … 3"这种只省略一页的折叠
  if (page <= 3) pages.add(2).add(3).add(4);
  if (page >= pageCount - 2) pages.add(pageCount - 1).add(pageCount - 2).add(pageCount - 3);

  const sorted = [...pages].filter((value) => value >= 1 && value <= pageCount).sort((a, b) => a - b);

  const result: Array<number | typeof GAP> = [];
  let previous = 0;
  for (const value of sorted) {
    if (previous && value - previous > 1) result.push(GAP);
    result.push(value);
    previous = value;
  }
  return result;
}

/** 页码分页(社区列表、管理表格) */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}): React.JSX.Element {
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(1, page), pageCount);

  // 空列表不占版面,空状态由列表自己的 EmptyState 负责
  if (total === 0) return <></>;

  const pages = buildPages(current, pageCount);

  return (
    <nav aria-label="分页" className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-fg-muted">
        共 <span className="tabular">{total}</span> 条,第 <span className="tabular">{current}</span> /{' '}
        <span className="tabular">{pageCount}</span> 页
      </p>

      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          aria-label="上一页"
          disabled={current <= 1}
          onClick={() => onPageChange(current - 1)}
          iconLeft={<ChevronLeft aria-hidden="true" className="size-4" />}
        >
          <span className="hidden sm:inline">上一页</span>
        </Button>

        {/* 移动端只留上一页/下一页 + 当前页码,页码按钮太小不好点 */}
        <span className="tabular px-2 text-sm text-fg-muted md:hidden">
          {current} / {pageCount}
        </span>

        <div className="hidden items-center gap-1 md:flex">
          {pages.map((value, index) =>
            value === GAP ? (
              <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-sm text-fg-subtle">
                …
              </span>
            ) : (
              <button
                key={value}
                type="button"
                aria-label={`第 ${value} 页`}
                aria-current={value === current ? 'page' : undefined}
                onClick={() => onPageChange(value)}
                className={cn(
                  'tabular inline-flex h-8 min-w-8 items-center justify-center rounded-sm px-2 text-sm transition-colors duration-150',
                  value === current
                    ? 'bg-accent-surface font-medium text-accent'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                )}
              >
                {value}
              </button>
            ),
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          aria-label="下一页"
          disabled={current >= pageCount}
          onClick={() => onPageChange(current + 1)}
          iconRight={<ChevronRight aria-hidden="true" className="size-4" />}
        >
          <span className="hidden sm:inline">下一页</span>
        </Button>
      </div>
    </nav>
  );
}

/** 游标分页的"加载更多"。默认进入视口后自动拉取(无限滚动),也可手动点击。 */
export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
  className,
  /** 视口进入时自动加载,默认开启 */
  infinite = true,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  className?: string;
  infinite?: boolean;
}): React.JSX.Element {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!infinite || !hasMore || loading) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, infinite, loading, onLoadMore]);

  if (!hasMore) {
    return (
      <p className={cn('py-4 text-center text-xs text-fg-subtle', className)} aria-live="polite">
        没有更多了
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col items-center gap-2 py-4', className)}>
      <div ref={sentinelRef} className="h-1 w-full" aria-hidden />
      <Button variant="secondary" size="md" loading={loading} onClick={onLoadMore}>
        {loading ? '加载中' : '加载更多'}
      </Button>
    </div>
  );
}
