'use client';

import type { PostListItem } from '@june/shared';
import { useInfiniteQuery } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

import { communityKeys } from '../api';

export function useUserPosts(userId: string) {
  const query = useInfiniteQuery({
    queryKey: communityKeys.userPosts(userId),
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '20' });
      if (pageParam) params.set('cursor', pageParam);
      return api.get<{ items: PostListItem[]; nextCursor: string | null; hasMore: boolean }>(
        `/community/users/${userId}/posts?${params.toString()}`,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return {
    items,
    isLoading: query.isLoading,
    hasMore: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
