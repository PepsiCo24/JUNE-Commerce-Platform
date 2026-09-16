'use client';

import {
  PAGE_SIZE_DEFAULT,
  commentCreateSchema,
  type CommentItem,
  type CursorResult,
} from '@june/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { communityKeys, createComment, deleteComment, fetchComments } from '../api';

type InfiniteComments = {
  pages: Array<CursorResult<CommentItem>>;
  pageParams: Array<string | undefined>;
};

/**
 * 评论区。顶级评论游标分页(每页 20),一级回复由后端挂在各自父评论下一次带回。
 * 表单校验直接复用 `commentCreateSchema`,与后端同一份规则。
 */
export function useComments(postId: string): {
  items: CommentItem[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
  submit: (input: { content: string; parentId?: string | null }) => Promise<CommentItem>;
  submitting: boolean;
  remove: (commentId: string) => Promise<void>;
  removing: boolean;
} {
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: communityKeys.comments(postId),
    queryFn: ({ pageParam, signal }) =>
      fetchComments(postId, { cursor: pageParam, limit: PAGE_SIZE_DEFAULT }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const items = useMemo(
    () => ((query.data as InfiniteComments | undefined)?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  );

  const createMutation = useMutation({
    mutationFn: (input: { content: string; parentId?: string | null }) => {
      // 提交前再用共享 schema 过一遍,避免绕过表单直接调用时把非法内容发给后端
      const parsed = commentCreateSchema.parse(input);
      return createComment(postId, parsed);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.comments(postId) });
      // 评论数在帖子卡片与详情页都要跟着变
      void queryClient.invalidateQueries({ queryKey: communityKeys.all });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.comments(postId) });
      void queryClient.invalidateQueries({ queryKey: communityKeys.all });
    },
  });

  return {
    items,
    isLoading: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    submit: (input) => createMutation.mutateAsync(input),
    submitting: createMutation.isPending,
    remove: (commentId) => removeMutation.mutateAsync(commentId),
    removing: removeMutation.isPending,
  };
}
