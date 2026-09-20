'use client';

import {
  PAGE_SIZE_DEFAULT,
  type CursorResult,
  type GenerationTaskView,
  type TaskStatusValue,
} from '@june/shared';
import { useInfiniteQuery } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

import { workbenchKeys } from '../lib/keys';

export type TaskListType = 'IMAGE_GENERATE' | 'IMAGE_EDIT' | 'TEXT_COPY' | 'TEXT_TITLE' | 'ALL';

export function useTaskList(params: { type: TaskListType; status: 'ALL' | TaskStatusValue }) {
  const query = useInfiniteQuery({
    queryKey: workbenchKeys.taskList(params),
    queryFn: ({ pageParam }) =>
      api.get<CursorResult<GenerationTaskView>>('/generation/tasks', {
        query: { type: params.type, status: params.status, cursor: pageParam, limit: PAGE_SIZE_DEFAULT },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

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
