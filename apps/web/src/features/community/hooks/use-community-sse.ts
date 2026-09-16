'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { toast } from 'sonner';

import { useSseEvent } from '@/providers/sse-provider';

import { communityKeys } from '../api';

/**
 * 管理员在后台隐藏 / 删除 / 置顶帖子后,在线页面要立刻知道。
 *
 * 做法:订阅 SSE 的 `post.updated`,把社区相关的查询整体置为失效。
 * 只失效不硬刷,列表下次获得焦点或用户滚动加载时自然取到新数据;
 * 影响到"当前正在看的这一篇"时才提示用户并刷新服务端组件。
 */
export function useCommunityListSync(): void {
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: communityKeys.all });
  }, [queryClient]);

  useSseEvent('post.updated', invalidate);
}

/**
 * 详情页的实时同步。
 *
 * 帖子详情是服务端组件渲染的,所以拿到事件后调用 `router.refresh()` 让服务端重新判定可见性——
 * 帖子被隐藏时会重新走后端的 POST_HIDDEN 分支渲染提示页,
 * 绝不会因为"前端已经拿到过内容"就继续展示。
 */
export function usePostDetailSync(params: { postId: string; slug: string }): void {
  const router = useRouter();
  const queryClient = useQueryClient();

  useSseEvent('post.updated', (event) => {
    if (event.type !== 'post.updated') return;
    if (event.postId !== params.postId && event.slug !== params.slug) return;

    if (event.action === 'hidden') {
      toast.warning('这篇内容刚刚被管理员隐藏');
    } else if (event.action === 'deleted') {
      toast.warning('这篇内容刚刚被删除');
    } else {
      toast.info('这篇内容有更新,正在刷新');
    }

    void queryClient.invalidateQueries({ queryKey: communityKeys.all });
    router.refresh();
  });

  useSseEvent('comment.updated', (event) => {
    if (event.type !== 'comment.updated') return;
    if (event.postId !== params.postId) return;

    // 自己刚发的评论已经在本地更新过,这里只需要让缓存失效以对齐其他人的改动
    void queryClient.invalidateQueries({ queryKey: communityKeys.comments(params.postId) });
    if (event.action === 'hidden' || event.action === 'deleted') {
      toast.info('有评论被管理员处理,评论区已更新');
    }
  });
}
