'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { useAuth } from '@/providers/auth-provider';
import { useSseEvent } from '@/providers/sse-provider';

/**
 * 会话失效的即时响应。
 *
 * 覆盖需求里"统一执行退出、禁用和密码修改后的会话失效规则":
 * 后端在这些动作发生时通过 SSE 推 session.invalidated,前端立刻清态并跳登录页,
 * 不需要等到下一次接口请求返回 401 才发现。
 *
 * 注意:这只是"更快的提示"。真正的失效由后端的 sessionEpoch 保证,
 * 即使前端忽略这个事件,任何后续请求也会被拒绝。
 */

const REASON_MESSAGES: Record<string, string> = {
  logout: '你已在其他设备退出登录',
  password_changed: '密码已修改,请使用新密码重新登录',
  disabled: '账号已被管理员禁用,请联系管理员',
  revoked: '登录状态已被终止,请重新登录',
};

export function SessionWatcher(): null {
  const router = useRouter();
  const { logout } = useAuth();

  useSseEvent('session.invalidated', (event) => {
    if (event.type !== 'session.invalidated') return;
    toast.error(REASON_MESSAGES[event.reason] ?? '登录状态已失效,请重新登录');
    void logout();
  });

  // 管理员修改内容后通知相关在线页面刷新;隐藏或删除的内容后端会直接拒绝访问
  useSseEvent('post.updated', (event) => {
    if (event.type !== 'post.updated') return;
    if (event.action === 'hidden' || event.action === 'deleted') {
      const path = window.location.pathname;
      // 正在浏览这篇被隐藏/删除的帖子:刷新后由服务端返回对应错误页
      if (path.includes(`/posts/${event.slug}`) || path.includes(`/p/${event.slug}`)) {
        toast.warning(event.action === 'hidden' ? '该内容已被管理员隐藏' : '该内容已被删除');
        router.refresh();
      }
    }
  });

  useEffect(() => {
    // 占位:未来如需监听浏览器 online/offline 可在此扩展
  }, []);

  return null;
}
