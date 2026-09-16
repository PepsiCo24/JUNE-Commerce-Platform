'use client';

import { ERROR_CODES } from '@june/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ApiError, describeError } from '@/lib/api/errors';

import { bookmarkPost, communityKeys, unbookmarkPost } from '../api';

/**
 * 收藏状态。
 *
 * 与 usePostLike 同口径:乐观翻转、进行中禁止重复点击、
 * 409 ALREADY_BOOKMARKED / NOT_BOOKMARKED 以服务端为准修正本地状态。
 */
export function usePostBookmark(params: {
  postId: string;
  initialBookmarked: boolean;
  onUnauthenticated?: () => void;
}): {
  bookmarked: boolean;
  pending: boolean;
  toggle: () => void;
} {
  const queryClient = useQueryClient();
  const [bookmarked, setBookmarked] = useState(params.initialBookmarked);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setBookmarked(params.initialBookmarked);
  }, [params.initialBookmarked]);

  const toggle = useCallback(() => {
    if (pending) return;

    const before = bookmarked;
    const next = !before;
    setBookmarked(next);
    setPending(true);

    void (async () => {
      try {
        const result = before
          ? await unbookmarkPost(params.postId)
          : await bookmarkPost(params.postId);
        if (!mountedRef.current) return;
        setBookmarked(result.bookmarked);
        void queryClient.invalidateQueries({ queryKey: communityKeys.all });
      } catch (error) {
        if (!mountedRef.current) return;

        if (error instanceof ApiError) {
          if (error.code === ERROR_CODES.ALREADY_BOOKMARKED) {
            setBookmarked(true);
            toast.info('你已经收藏过了');
            void queryClient.invalidateQueries({ queryKey: communityKeys.all });
            return;
          }
          if (error.code === ERROR_CODES.NOT_BOOKMARKED) {
            setBookmarked(false);
            toast.info('你还没有收藏');
            void queryClient.invalidateQueries({ queryKey: communityKeys.all });
            return;
          }
          if (error.isAuthError) {
            setBookmarked(before);
            params.onUnauthenticated?.();
            return;
          }
        }

        setBookmarked(before);
        toast.error(describeError(error));
      } finally {
        if (mountedRef.current) setPending(false);
      }
    })();
  }, [pending, bookmarked, params, queryClient]);

  return { bookmarked, pending, toggle };
}
