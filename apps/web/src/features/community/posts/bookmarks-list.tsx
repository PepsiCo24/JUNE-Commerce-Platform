'use client';

import { Bookmark } from 'lucide-react';
import Link from 'next/link';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { LoadMore } from '@/components/ui/pagination';

import { useCommunityListSync } from '../hooks/use-community-sse';
import { useBookmarkList } from '../hooks/use-post-list';
import { CommunityPersonalNav } from './post-hall';
import { PostCard } from './post-card';
import { PostGridSkeleton } from './post-card-skeleton';

/**
 * 我的收藏列表。不可访问的帖子以 unavailable 卡片展示,仍可取消收藏。
 */
export function BookmarksList(): React.JSX.Element {
  const list = useBookmarkList();
  useCommunityListSync();

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-5">
      <header className="flex flex-col gap-3">
        <h1 className="text-lg font-semibold text-fg sm:text-xl">我的收藏</h1>
        <CommunityPersonalNav />
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
          <LoadMore
            hasMore={list.hasMore}
            loading={list.isFetchingNextPage}
            onLoadMore={list.loadMore}
          />
        </>
      ) : null}
    </div>
  );
}
