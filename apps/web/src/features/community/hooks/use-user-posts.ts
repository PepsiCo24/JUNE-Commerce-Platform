'use client';

import { PAGE_SIZE_DEFAULT, type PageResult, type PostListItem } from '@june/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '@/lib/api/client';

import { communityKeys } from '../api';

export function useUserPosts(userId: string) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: communityKeys.userPosts(userId, page),
    queryFn: ({ signal }) =>
      api.get<PageResult<PostListItem>>(`/community/users/${userId}/posts`, {
        query: { page, pageSize: PAGE_SIZE_DEFAULT },
        signal,
      }),
  });

  const data = query.data;

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? page,
    pageSize: data?.pageSize ?? PAGE_SIZE_DEFAULT,
    totalPages: data?.totalPages ?? 1,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    setPage,
    refetch: () => void query.refetch(),
  };
}
