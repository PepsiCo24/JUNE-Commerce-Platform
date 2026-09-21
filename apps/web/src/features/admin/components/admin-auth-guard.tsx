'use client';

import type { ReactNode } from 'react';

import { LoadingState } from '@/components/feedback/states';
import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';

/** 控制台页守卫:必须存在有效管理员会话(含 isAdmin)。 */
export function AdminAuthGuard({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, isLoading, isAuthenticated } = useAdminAuth();

  if (isLoading) {
    return <LoadingState message="正在校验管理员会话" className="min-h-dvh" />;
  }

  if (!isAuthenticated || !user?.isAdmin) {
    return <LoadingState message="正在跳转登录页" className="min-h-dvh" />;
  }

  return <>{children}</>;
}
