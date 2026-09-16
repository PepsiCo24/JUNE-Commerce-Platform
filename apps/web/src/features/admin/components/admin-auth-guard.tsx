'use client';

import type { ReactNode } from 'react';

import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';
import { LoadingState } from '@/components/feedback/states';

/** 控制台页守卫:探测完成且无会话时由 Provider 负责跳登录,这里只挡住闪屏。 */
export function AdminAuthGuard({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, isLoading } = useAdminAuth();

  if (isLoading || !user) {
    return <LoadingState message="正在校验管理员会话" className="min-h-dvh" />;
  }

  return <>{children}</>;
}
