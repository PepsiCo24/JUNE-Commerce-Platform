'use client';

import { ERROR_CODES } from '@june/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ApiError, describeError } from '@/lib/api/errors';

import { communityKeys, likePost, unlikePost } from '../api';

interface LikeState {
  liked: boolean;
  count: number;
}

/**
 * 点赞状态。
 *
 * - 乐观更新:点击即翻转,请求失败回滚到点击前的值。
 * - 服务端才是判定方:后端用数据库唯一约束防重复,返回 409 ALREADY_LIKED / NOT_LIKED 时
 *   说明本地状态和服务端不一致(多标签页、返回缓存页),这时**以服务端为准**修正状态,
 *   而不是把本地的错误状态再写回去。
 * - 请求进行中禁止重复点击,避免把 like/unlike 打成竞态。
 */
export function usePostLike(params: {
  postId: string;
  initialLiked: boolean;
  initialCount: number;
  /** 未登录时的处理(通常是引导登录),不传则由后端 401 触发全局跳转 */
  onUnauthenticated?: () => void;
}): {
  liked: boolean;
  count: number;
  pending: boolean;
  toggle: () => void;
} {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LikeState>({
    liked: params.initialLiked,
    count: params.initialCount,
  });
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 服务端重新渲染(router.refresh / 重新进入页面)带来新的初始值时对齐本地状态
  useEffect(() => {
    setState({ liked: params.initialLiked, count: params.initialCount });
  }, [params.initialLiked, params.initialCount]);

  const toggle = useCallback(() => {
    if (pending) return;

    const before = state;
    const next: LikeState = before.liked
      ? { liked: false, count: Math.max(0, before.count - 1) }
      : { liked: true, count: before.count + 1 };

    setState(next);
    setPending(true);

    void (async () => {
      try {
        const result = before.liked ? await unlikePost(params.postId) : await likePost(params.postId);
        if (!mountedRef.current) return;
        // 计数用服务端返回值,避免并发点赞时本地加减出现偏差
        setState({ liked: result.liked, count: result.likeCount });
        void queryClient.invalidateQueries({ queryKey: communityKeys.all });
      } catch (error) {
        if (!mountedRef.current) return;

        if (error instanceof ApiError) {
          if (error.code === ERROR_CODES.ALREADY_LIKED) {
            // 服务端说已点过赞:保持"已点赞",计数交给下一次取数校正
            setState({ liked: true, count: Math.max(before.count, next.count) });
            toast.info('你已经点过赞了');
            void queryClient.invalidateQueries({ queryKey: communityKeys.all });
            return;
          }
          if (error.code === ERROR_CODES.NOT_LIKED) {
            setState({ liked: false, count: Math.min(before.count, next.count) });
            toast.info('你还没有点赞');
            void queryClient.invalidateQueries({ queryKey: communityKeys.all });
            return;
          }
          if (error.isAuthError) {
            setState(before);
            params.onUnauthenticated?.();
            return;
          }
        }

        setState(before);
        toast.error(describeError(error));
      } finally {
        if (mountedRef.current) setPending(false);
      }
    })();
  }, [pending, state, params, queryClient]);

  return { liked: state.liked, count: state.count, pending, toggle };
}
