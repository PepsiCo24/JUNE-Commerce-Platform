'use client';

import {
  COMMUNITY_SEARCH_TYPES,
  POST_CATEGORIES,
  POST_CATEGORY_LABELS,
  POST_SORT_DEFAULT,
  POST_SORT_OPTIONS,
  type CommunitySearchType,
  type CommunityUserSummary,
  type PostCategory,
  type PostSort,
} from '@june/shared';
import { PenLine, Pin, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { LoadMore } from '@/components/ui/pagination';
import { Separator } from '@/components/ui/separator';
import { cn, formatCount } from '@/lib/utils';

import { useCommunityListSync } from '../hooks/use-community-sse';
import { useInfinitePostList, useUserSearch } from '../hooks/use-post-list';
import { CommunityHallToolbar } from '../layout/community-hall-toolbar';
import { PostCard } from './post-card';
import { PostGridSkeleton } from './post-card-skeleton';

/** 搜索防抖:400ms 后才写入 URL,避免每敲一个字都发一次请求 */
const SEARCH_DEBOUNCE_MS = 400;

const PERSONAL_NAV = [
  { href: '/community', label: '全部帖子', match: (path: string) => path === '/community' },
  { href: '/community/mine', label: '我的帖子', match: (path: string) => path.startsWith('/community/mine') },
  {
    href: '/community/bookmarks',
    label: '我的收藏',
    match: (path: string) => path.startsWith('/community/bookmarks'),
  },
  {
    href: '/community/drafts',
    label: '草稿箱',
    match: (path: string) => path.startsWith('/community/drafts'),
  },
] as const;

function parseSort(value: string | null): PostSort {
  return (POST_SORT_OPTIONS as readonly string[]).includes(value ?? '')
    ? (value as PostSort)
    : POST_SORT_DEFAULT;
}

function parseSearchType(value: string | null): CommunitySearchType {
  return (COMMUNITY_SEARCH_TYPES as readonly string[]).includes(value ?? '')
    ? (value as CommunitySearchType)
    : 'all';
}

function parseCategory(value: string | null): PostCategory | 'all' {
  if (!value || value === 'all') return 'all';
  return (POST_CATEGORIES as readonly string[]).includes(value) ? (value as PostCategory) : 'all';
}

/**
 * 帖子大厅(紧凑信息流)。
 * 搜索词、类型、分类、排序写进 URL query,可分享、可前进后退。
 * 默认按点赞量排序;列表底部无限滚动懒加载。
 */
export function PostHall(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sort = parseSort(searchParams.get('sort'));
  const type = parseSearchType(searchParams.get('type'));
  const category = parseCategory(searchParams.get('category'));
  const q = searchParams.get('q')?.trim() ?? '';

  const [keyword, setKeyword] = useState(q);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedRef = useRef(q);

  useEffect(() => {
    if (q !== lastAppliedRef.current) {
      lastAppliedRef.current = q;
      setKeyword(q);
    }
  }, [q]);

  const pushQuery = useCallback(
    (next: {
      q?: string;
      sort?: PostSort;
      type?: CommunitySearchType;
      category?: PostCategory | 'all';
    }) => {
      const params = new URLSearchParams(searchParams.toString());
      const nextQ = next.q !== undefined ? next.q : q;
      const nextSort = next.sort ?? sort;
      const nextType = next.type ?? type;
      const nextCategory = next.category ?? category;

      if (nextQ) params.set('q', nextQ);
      else params.delete('q');

      if (nextType === 'all') params.delete('type');
      else params.set('type', nextType);

      if (nextCategory === 'all') params.delete('category');
      else params.set('category', nextCategory);

      if (nextType === 'users' || nextSort === POST_SORT_DEFAULT) params.delete('sort');
      else params.set('sort', nextSort);

      // 大厅改回无限滚动,不再用 URL page
      params.delete('page');

      const query = params.toString();
      lastAppliedRef.current = nextQ;
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [category, pathname, q, router, searchParams, sort, type],
  );

  const onKeywordChange = useCallback(
    (value: string) => {
      setKeyword(value);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pushQuery({ q: value.trim() });
      }, SEARCH_DEBOUNCE_MS);
    },
    [pushQuery],
  );

  const clearSearch = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setKeyword('');
    pushQuery({ q: '' });
  }, [pushQuery]);

  const submitSearch = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pushQuery({ q: keyword.trim() });
  }, [keyword, pushQuery]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const showPosts = type === 'all' || type === 'posts';
  const showUsers = type === 'all' || type === 'users';

  const postParams = useMemo(
    () => ({
      sort,
      q: q || undefined,
      category: category === 'all' ? undefined : category,
    }),
    [sort, q, category],
  );
  const postList = useInfinitePostList(postParams, { enabled: showPosts });
  const userList = useUserSearch({ q, enabled: showUsers && Boolean(q) });

  useCommunityListSync();

  const categoryItems = useMemo(
    () => [
      { value: 'all', label: '全部分类' },
      ...POST_CATEGORIES.map((value) => ({
        value,
        label: POST_CATEGORY_LABELS[value],
      })),
    ],
    [],
  );

  const postsLoading = showPosts && postList.isLoading;
  const usersLoading = showUsers && Boolean(q) && userList.isLoading;
  const isLoading = postsLoading || usersLoading;

  const postsEmpty =
    showPosts
    && !postList.isLoading
    && !postList.isError
    && postList.pinned.length === 0
    && postList.normal.length === 0;
  const usersEmpty =
    showUsers
    && Boolean(q)
    && !userList.isLoading
    && !userList.isError
    && userList.items.length === 0;
  const usersNeedQuery = showUsers && !q && type === 'users';

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 lg:max-w-none">
      <header className="flex flex-col gap-2 lg:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-fg">社区</h1>
            <p className="mt-0.5 text-sm text-fg-muted">讨论运营经验、晒单案例与实用资源</p>
          </div>
          <Button asChild size="sm" iconLeft={<PenLine size={14} />}>
            <Link href="/community/posts/new">发布</Link>
          </Button>
        </div>

        <nav aria-label="个人内容" className="flex flex-wrap items-center gap-1 text-sm">
          {PERSONAL_NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-2.5 py-1 transition-colors',
                  active
                    ? 'bg-accent-surface text-accent'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <h1 className="sr-only">社区</h1>

      <CommunityHallToolbar
        keyword={keyword}
        type={type}
        sort={sort}
        category={category}
        categoryItems={categoryItems}
        onKeywordChange={onKeywordChange}
        onSubmitSearch={submitSearch}
        onClearSearch={clearSearch}
        onTypeChange={(value) => pushQuery({ type: value })}
        onSortChange={(value) => pushQuery({ sort: value })}
        onCategoryChange={(value) => pushQuery({ category: value })}
      />

      {isLoading ? <PostGridSkeleton /> : null}

      {!isLoading && showPosts && postList.isError ? (
        <ErrorState error={postList.error} onRetry={postList.refetch} title="帖子列表加载失败" />
      ) : null}

      {!isLoading && showUsers && Boolean(q) && userList.isError ? (
        <ErrorState error={userList.error} onRetry={userList.refetch} title="用户搜索失败" />
      ) : null}

      {!isLoading ? (
        <>
          {usersNeedQuery ? (
            <EmptyState
              icon={<UserRound size={28} />}
              title="搜索用户"
              description="输入昵称关键词,查找社区里的创作者。"
            />
          ) : null}

          {showUsers && Boolean(q) && !userList.isLoading && !userList.isError ? (
            <section aria-labelledby="users-heading" className="flex flex-col gap-2">
              {type === 'all' && userList.items.length > 0 ? (
                <h2 id="users-heading" className="text-sm font-medium text-fg-muted">
                  用户
                </h2>
              ) : (
                <h2 id="users-heading" className="sr-only">
                  用户搜索结果
                </h2>
              )}

              {usersEmpty && type === 'users' ? (
                <EmptyState
                  icon={<UserRound size={28} />}
                  title={`没有匹配「${q}」的用户`}
                  description="换个昵称关键词试试。"
                  action={
                    <Button variant="secondary" onClick={clearSearch}>
                      清空搜索
                    </Button>
                  }
                />
              ) : null}

              {userList.items.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {userList.items.map((user) => (
                    <li key={user.id}>
                      <UserResultRow user={user} />
                    </li>
                  ))}
                </ul>
              ) : null}

              {type === 'users' ? (
                <LoadMore
                  hasMore={userList.hasMore}
                  loading={userList.isFetchingNextPage}
                  onLoadMore={userList.loadMore}
                />
              ) : null}
            </section>
          ) : null}

          {showPosts && showUsers && Boolean(q) && userList.items.length > 0 && !postsEmpty ? (
            <Separator className="my-1" />
          ) : null}

          {showPosts && !postList.isLoading && !postList.isError ? (
            <>
              {postsEmpty
              && (type === 'posts' || !q || type === 'all')
              && !(type === 'all' && Boolean(q) && userList.items.length > 0) ? (
                <EmptyState
                  icon={<PenLine size={28} />}
                  title={q ? `没有匹配「${q}」的帖子` : '社区还没有内容'}
                  description={
                    q
                      ? '换个关键词或分类试试,或者清空搜索看看全部内容。'
                      : '成为第一个分享的人吧。'
                  }
                  action={
                    q || category !== 'all' ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          clearSearch();
                          pushQuery({ category: 'all' });
                        }}
                      >
                        清空筛选
                      </Button>
                    ) : (
                      <Button asChild iconLeft={<PenLine size={16} />}>
                        <Link href="/community/posts/new">写第一篇</Link>
                      </Button>
                    )
                  }
                />
              ) : null}

              {postList.pinned.length > 0 ? (
                <section aria-labelledby="pinned-heading" className="flex flex-col gap-1.5">
                  <h2
                    id="pinned-heading"
                    className="flex items-center gap-2 text-sm font-medium text-accent"
                  >
                    <Pin size={15} aria-hidden />
                    置顶内容
                  </h2>
                  <div className="flex flex-col gap-1.5">
                    {postList.pinned.map((post) => (
                      <PostCard key={post.id} post={post} pinned />
                    ))}
                  </div>
                  {postList.normal.length > 0 ? <Separator className="my-1" /> : null}
                </section>
              ) : null}

              {postList.normal.length > 0 ? (
                <section aria-labelledby="posts-heading" className="flex flex-col gap-1.5">
                  <h2 id="posts-heading" className="sr-only">
                    {type === 'all' && q ? '帖子' : '帖子列表'}
                  </h2>
                  {type === 'all' && q && postList.normal.length > 0 ? (
                    <p className="text-sm font-medium text-fg-muted" aria-hidden>
                      帖子
                    </p>
                  ) : null}
                  {postList.normal.map((post) => (
                    <PostCard key={post.id} post={post} />
                  ))}
                </section>
              ) : null}

              {postList.normal.length > 0 || postList.pinned.length > 0 ? (
                <LoadMore
                  hasMore={postList.hasMore}
                  loading={postList.isFetchingNextPage}
                  onLoadMore={postList.loadMore}
                />
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function UserResultRow({ user }: { user: CommunityUserSummary }): React.JSX.Element {
  const profileHref = `/community/users/${user.id}`;

  return (
    <div className="community-card-enter flex items-start gap-3 rounded-lg border border-border-default bg-bg-elevated px-3 py-2.5">
      <Link href={profileHref}>
        <Avatar src={user.avatarUrl} name={user.displayName} size={36} />
      </Link>
      <div className="min-w-0 flex-1">
        <Link href={profileHref} className="truncate font-medium text-fg hover:text-accent">
          {user.displayName}
        </Link>
        {user.bio ? (
          <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">{user.bio}</p>
        ) : (
          <p className="mt-0.5 text-sm text-fg-subtle">暂无简介</p>
        )}
        <p className="mt-1 text-xs text-fg-subtle">
          {formatCount(user.publishedPostCount)} 篇公开帖子
        </p>
      </div>
      <Button variant="secondary" size="sm" asChild>
        <Link href={profileHref}>查看主页</Link>
      </Button>
    </div>
  );
}

/** 供收藏等子页复用的个人导航 */
export function CommunityPersonalNav({ className }: { className?: string }): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav
      aria-label="个人内容"
      className={cn('flex flex-wrap items-center gap-1 text-sm', className)}
    >
      {PERSONAL_NAV.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1 transition-colors',
              active
                ? 'bg-accent-surface text-accent'
                : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
            )}
          >
            {item.label}
          </Link>
        );
      })}
      <Link
        href="/community/posts/new"
        className="ml-auto inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-accent hover:bg-accent-surface"
      >
        <PenLine size={14} aria-hidden />
        发布
      </Link>
    </nav>
  );
}
