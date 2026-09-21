import type { AuthStateResponse } from '@june/shared';
import { redirect } from 'next/navigation';

import { serverGetOptional } from '@/lib/api/server';

/**
 * 若当前浏览器带着**站点**会话且不是管理员,禁止进入 /admin/**。
 * 管理员仍可打开 /admin/login(即使同时有站点会话)。
 * 未登录访客也可打开登录页(否则管理员无法首次登录)。
 *
 * 真正权限边界仍在后端 ADMIN 会话 + RolesGuard;这里挡住 URL 直达体验。
 */
export async function rejectNonAdminSiteUserFromAdmin(): Promise<void> {
  const state = await serverGetOptional<AuthStateResponse>('/auth/me');
  if (state?.user && !state.user.isAdmin) {
    redirect('/');
  }
}
