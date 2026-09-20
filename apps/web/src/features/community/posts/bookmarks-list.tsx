'use client';

import { Bookmark } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback } from 'react';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';

import { useCommunityListSync } from '../hooks/use-community-sse';
import { useBookmarkList } from '../hooks/use-post-list';
import { CommunityPersonalNav } from './post-hall';
import { PostCard } from './post-card';
import { PostGridSkeleton } from './post-card-skeleton';

/**
 * 我的收藏列表。不可访问的帖子以 unavailable 卡片展示,仍可取消收藏。
 */
export function BookmarksList(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const list = useBookmarkList({ page });
  useCommunityListSync();

  const setPage = useCallback(
    (next: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next <= 1) params.delete('page');
      else params.set('page', String(next));
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [pathname, router, searchParams],
  );

  return (
    <div className="flex w-full flex-col gap-5">
      <header className="flex flex-col gap-3">
        <h1 className="text-lg font-semibold text-fg sm:text-xl">我的收藏</h1>
        <CommunityPersonalNav className="lg:hidden" />
      </header>

      {list.isLoading ? <PostGridSkeleton /> : null}

      {!list.isLoading && list.isError ? (
        <ErrorState error={list.error} onRetry={list.refetch} title="收藏列表加载失败" />
      ) : null}

      {!list.isLoading && !list.isError && list.items.length === 0 ? (
        <EmptyState
          icon={<Bookmark size={28} />}
          title="还没有收藏"
          description="在帖子卡片或详情页点收藏,内容会出现在这里。"
          action={
            <Button asChild variant="secondary">
              <Link href="/community">去社区逛逛</Link>
            </Button>
          }
        />
      ) : null}

      {!list.isLoading && !list.isError && list.items.length > 0 ? (
        <>
          <div className="flex flex-col gap-3 sm:gap-4">
            {list.items.map((post) => (
              <PostCard key={post.id} post={post} showShare={!post.unavailable} />
            ))}
          </div>
          <Pagination
            page={list.page}
            pageSize={list.pageSize}
            total={list.total}
            onPageChange={setPage}
          />
        </>
      ) : null}
    </div>
  );
}
