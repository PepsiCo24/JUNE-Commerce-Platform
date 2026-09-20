'use client';

import {
  type CommunitySearchType,
  type PostCategory,
  type PostSort,
} from '@june/shared';
import { Search, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import { HotSortHint } from '../posts/hot-sort-hint';

const TYPE_ITEMS: Array<{ value: CommunitySearchType; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'posts', label: '帖子' },
  { value: 'users', label: '用户' },
];

const SORT_ITEMS: Array<{ value: PostSort; label: string }> = [
  { value: 'most_liked', label: '最多点赞' },
  { value: 'latest', label: '最新发布' },
  { value: 'most_commented', label: '最多评论' },
  { value: 'hot', label: '热门' },
];

export type CommunityHallToolbarProps = {
  keyword: string;
  type: CommunitySearchType;
  sort: PostSort;
  category: PostCategory | 'all';
  categoryItems: Array<{ value: string; label: string }>;
  onKeywordChange: (value: string) => void;
  onSubmitSearch: () => void;
  onClearSearch: () => void;
  onTypeChange: (value: CommunitySearchType) => void;
  onSortChange: (value: PostSort) => void;
  onCategoryChange: (value: PostCategory | 'all') => void;
};

/**
 * 社区大厅搜索/筛选条。
 * 大屏 Portal 进顶栏中间空位;小屏留在主列顶部,避免挤爆顶栏。
 */
export function CommunityHallToolbar(props: CommunityHallToolbarProps): React.JSX.Element {
  const [topSlot, setTopSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const sync = (): void => {
      setTopSlot(document.getElementById('app-topbar-center'));
    };
    sync();
    // 顶栏偶发晚于大厅挂载时补一次,避免搜索条掉回主列
    const timer = window.setTimeout(sync, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <>
      {topSlot
        ? createPortal(<ToolbarBody {...props} density="topbar" />, topSlot)
        : null}
      {/* 大屏已 Portal 进顶栏时不再占主列;小屏保留内联条 */}
      <div className={topSlot ? 'md:hidden' : undefined}>
        <ToolbarBody {...props} density="inline" />
      </div>
    </>
  );
}

function ToolbarBody({
  density,
  keyword,
  type,
  sort,
  category,
  categoryItems,
  onKeywordChange,
  onSubmitSearch,
  onClearSearch,
  onTypeChange,
  onSortChange,
  onCategoryChange,
}: CommunityHallToolbarProps & { density: 'topbar' | 'inline' }): React.JSX.Element {
  const showSort = type !== 'users';
  const compact = density === 'topbar';

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2',
        compact ? 'w-full' : 'rounded-xl border border-border-default bg-bg-elevated p-2.5',
      )}
    >
      <div className={cn('flex min-w-0 items-center gap-2', compact && 'h-9')}>
        <div className={cn('relative min-w-0', compact ? 'max-w-[220px] flex-1 lg:max-w-[280px]' : 'w-full')}>
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={keyword}
            onChange={(event) => onKeywordChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmitSearch();
              }
            }}
            placeholder={compact ? '搜索帖子或用户' : '搜索标题、正文或用户昵称'}
            aria-label="搜索标题、正文或用户昵称"
            className={cn('pr-8 pl-8', compact ? 'h-8 text-sm' : 'h-9')}
            type="search"
          />
          {keyword ? (
            <button
              type="button"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg"
              aria-label="清空搜索"
              onClick={onClearSearch}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>

        <Segmented
          ariaLabel="搜索类型"
          value={type}
          items={TYPE_ITEMS}
          onChange={onTypeChange}
          compact={compact}
          className="shrink-0"
        />

        {showSort && compact ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Segmented
              ariaLabel="排序"
              value={sort}
              items={SORT_ITEMS}
              onChange={onSortChange}
              compact
              className="min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            />
            {sort === 'hot' ? <HotSortHint /> : null}
          </div>
        ) : null}
      </div>

      {showSort && !compact ? (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="排序"
            value={sort}
            items={SORT_ITEMS}
            onChange={onSortChange}
            compact={false}
          />
          {sort === 'hot' ? <HotSortHint /> : null}
        </div>
      ) : null}

      {showSort && !compact ? (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label="分类">
          {categoryItems.map((item) => {
            const active = category === item.value;
            return (
              <button
                key={item.value}
                type="button"
                role="listitem"
                aria-pressed={active}
                onClick={() =>
                  onCategoryChange(item.value === 'all' ? 'all' : (item.value as PostCategory))
                }
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'bg-accent text-accent-fg'
                    : 'bg-surface-hover text-fg-muted hover:text-fg',
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
  compact,
  className,
}: {
  value: T;
  items: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  compact: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'flex items-center',
        compact
          ? 'gap-0.5 rounded-md border border-border-default bg-surface p-0.5'
          : 'shrink-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.value)}
            className={cn(
              'shrink-0 transition-colors',
              compact
                ? cn(
                    'rounded px-2 py-1 text-xs whitespace-nowrap',
                    selected
                      ? 'bg-bg-elevated font-medium text-accent shadow-sm'
                      : 'text-fg-muted hover:text-fg',
                  )
                : cn(
                    '-mb-px border-b-2 px-2.5 py-1.5 text-sm font-medium',
                    selected
                      ? 'border-accent text-accent'
                      : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
                  ),
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
