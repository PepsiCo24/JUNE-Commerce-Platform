'use client';

import {
  PAGE_SIZE_DEFAULT,
  type CommunityUserSummary,
  type CursorResult,
  type PostListItem,
} from '@june/shared';
import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  communityKeys,
  fetchBookmarks,
  fetchMyPosts,
  fetchPosts,
  fetchUserSearch,
  type MyPostStatus,
  type PostListParams,
} from '../api';

/**
 * 后端是键集游标分页(不是页码),所以列表统一用 useInfiniteQuery + "加载更多",
 * 而不是伪造一个总数去渲染页码。每页默认 20 条(PAGE_SIZE_DEFAULT)。
 */
export interface PostListResult {
  /** 置顶帖。后端在首屏一次性带出并按 pinnedOrder 排好序,前端只负责分组展示 */
  pinned: PostListItem[];
  /** 普通帖子流 */
  normal: PostListItem[];
  total: number;
  query: UseInfiniteQueryResult<{ pages: Array<CursorResult<PostListItem>> }, Error>;
}

type InfinitePosts = { pages: Array<CursorResult<PostListItem>>; pageParams: Array<string | undefined> };

function splitPinned(pages: Array<CursorResult<PostListItem>> | undefined): {
  pinned: PostListItem[];
  normal: PostListItem[];
} {
  const items = (pages ?? []).flatMap((page) => page.items);
  const pinned: PostListItem[] = [];
  const normal: PostListItem[] = [];
  for (const item of items) {
    if (item.isPinned) pinned.push(item);
    else normal.push(item);
  }
  return { pinned, normal };
}

export function usePostList(
  params: PostListParams,
  options: { enabled?: boolean } = {},
): {
  pinned: PostListItem[];
  normal: PostListItem[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
} {
  const enabled = options.enabled ?? true;
  const query = useInfiniteQuery({
    queryKey: communityKeys.posts(params),
    queryFn: ({ pageParam, signal }) =>
      fetchPosts({ ...params, cursor: pageParam, limit: PAGE_SIZE_DEFAULT }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
  });

  const { pinned, normal } = useMemo(
    () => splitPinned((query.data as InfinitePosts | undefined)?.pages),
    [query.data],
  );

  return {
    pinned,
    normal,
    isLoading: enabled ? query.isPending : false,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

/** 我的内容。草稿只有作者能拿到(后端每个查询都带 authorId),前端不做任何越权尝试。 */
export function useMyPostList(params: { status: MyPostStatus; q?: string }): {
  items: PostListItem[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
} {
  const query = useInfiniteQuery({
    queryKey: communityKeys.myPosts(params),
    queryFn: ({ pageParam, signal }) =>
      fetchMyPosts({ ...params, cursor: pageParam, limit: PAGE_SIZE_DEFAULT }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const items = useMemo(
    () => ((query.data as InfinitePosts | undefined)?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  );

  return {
    items,
    isLoading: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

/** 我的收藏。不可访问的帖子会带 unavailable=true,仍可取消收藏。 */
export function useBookmarkList(params: { q?: string } = {}): {
  items: PostListItem[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
} {
  const query = useInfiniteQuery({
    queryKey: communityKeys.bookmarks(params),
    queryFn: ({ pageParam, signal }) =>
      fetchBookmarks({ ...params, cursor: pageParam, limit: PAGE_SIZE_DEFAULT }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const items = useMemo(
    () => ((query.data as InfinitePosts | undefined)?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  );

  return {
    items,
    isLoading: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

type InfiniteUsers = {
  pages: Array<CursorResult<CommunityUserSummary>>;
  pageParams: Array<string | undefined>;
};

/** 用户昵称搜索。q 为空时不发请求。 */
export function useUserSearch(params: { q: string; enabled?: boolean }): {
  items: CommunityUserSummary[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
} {
  const keyword = params.q.trim();
  const enabled = (params.enabled ?? true) && keyword.length > 0;

  const query = useInfiniteQuery({
    queryKey: communityKeys.users({ q: keyword }),
    queryFn: ({ pageParam, signal }) =>
      fetchUserSearch({ q: keyword, cursor: pageParam, limit: PAGE_SIZE_DEFAULT }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
  });

  const items = useMemo(
    () => ((query.data as InfiniteUsers | undefined)?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  );

  return {
    items,
    isLoading: enabled ? query.isPending : false,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}
