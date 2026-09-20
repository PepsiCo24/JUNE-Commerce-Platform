'use client';

import {
  PAGE_SIZE_DEFAULT,
  type CommunityUserSummary,
  type CursorResult,
  type PageResult,
  type PostListItem,
} from '@june/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
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

function splitPinned(items: PostListItem[]): {
  pinned: PostListItem[];
  normal: PostListItem[];
} {
  const pinned: PostListItem[] = [];
  const normal: PostListItem[] = [];
  for (const item of items) {
    if (item.isPinned) pinned.push(item);
    else normal.push(item);
  }
  return { pinned, normal };
}

/** 帖子大厅:页码分页,page 由调用方从 URL 传入(侧栏热帖等单页场景) */
export function usePostList(
  params: PostListParams & { page?: number; pageSize?: number },
  options: { enabled?: boolean } = {},
): {
  pinned: PostListItem[];
  normal: PostListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
} {
  const enabled = options.enabled ?? true;
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? PAGE_SIZE_DEFAULT;
  const query = useQuery({
    queryKey: communityKeys.posts({ ...params, page }),
    queryFn: ({ signal }) => fetchPosts({ ...params, page, pageSize }, signal),
    enabled,
  });

  const data = query.data as PageResult<PostListItem> | undefined;
  const { pinned, normal } = useMemo(() => splitPinned(data?.items ?? []), [data?.items]);

  return {
    pinned,
    normal,
    total: data?.total ?? 0,
    page: data?.page ?? page,
    pageSize: data?.pageSize ?? pageSize,
    totalPages: data?.totalPages ?? 1,
    isLoading: enabled ? query.isPending : false,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

type InfinitePosts = {
  pages: Array<PageResult<PostListItem>>;
  pageParams: number[];
};

/**
 * 帖子大厅无限滚动:后端仍是 page/pageSize,前端累加翻页(知乎式懒加载)。
 * 大厅固定每页 10 条;置顶只出现在第 1 页。
 */
export function useInfinitePostList(
  params: PostListParams,
  options: { enabled?: boolean } = {},
): {
  pinned: PostListItem[];
  normal: PostListItem[];
  total: number;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
} {
  const enabled = options.enabled ?? true;
  const pageSize = 10;
  const query = useInfiniteQuery({
    queryKey: communityKeys.postsFeed({ ...params, pageSize }),
    queryFn: ({ pageParam, signal }) =>
      fetchPosts({ ...params, page: pageParam, pageSize }, signal),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    enabled,
  });

  const pages = (query.data as InfinitePosts | undefined)?.pages ?? [];

  const { pinned, normal } = useMemo(() => {
    const seen = new Set<string>();
    const pinnedItems: PostListItem[] = [];
    const normalItems: PostListItem[] = [];

    for (const page of pages) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (item.isPinned) pinnedItems.push(item);
        else normalItems.push(item);
      }
    }
    return { pinned: pinnedItems, normal: normalItems };
  }, [pages]);

  return {
    pinned,
    normal,
    total: pages[0]?.total ?? 0,
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
export function useMyPostList(params: {
  status: MyPostStatus;
  q?: string;
  page?: number;
  pageSize?: number;
}): {
  items: PostListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
} {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? PAGE_SIZE_DEFAULT;
  const query = useQuery({
    queryKey: communityKeys.myPosts({ status: params.status, q: params.q, page }),
    queryFn: ({ signal }) =>
      fetchMyPosts({ status: params.status, q: params.q, page, pageSize }, signal),
  });

  const data = query.data as PageResult<PostListItem> | undefined;

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? page,
    pageSize: data?.pageSize ?? pageSize,
    totalPages: data?.totalPages ?? 1,
    isLoading: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

export function useBookmarkList(
  params: { q?: string; page?: number; pageSize?: number } = {},
): {
  items: PostListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
} {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? PAGE_SIZE_DEFAULT;
  const query = useQuery({
    queryKey: communityKeys.bookmarks({ q: params.q, page }),
    queryFn: ({ signal }) => fetchBookmarks({ q: params.q, page, pageSize }, signal),
  });

  const data = query.data as PageResult<PostListItem> | undefined;

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? page,
    pageSize: data?.pageSize ?? pageSize,
    totalPages: data?.totalPages ?? 1,
    isLoading: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

type InfiniteUsers = {
  pages: Array<CursorResult<CommunityUserSummary>>;
  pageParams: Array<string | undefined>;
};

/** 用户搜索仍走游标 + 加载更多(结果量通常较小) */
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
  const enabled = (params.enabled ?? true) && Boolean(keyword);
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
