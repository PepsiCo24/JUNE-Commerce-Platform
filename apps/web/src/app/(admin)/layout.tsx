import { AdminAuthProvider } from '@/features/admin/providers/admin-auth-provider';
import { rejectNonAdminSiteUserFromAdmin } from '@/features/admin/lib/reject-non-admin';

/**
 * 管理站路由组外壳。浅色主题由控制台布局挂上;
 * 登录页自行使用深色容器。会话与站点完全独立。
 *
 * 普通站点用户(非管理员)即使直接输入 /admin URL 也会被踢回首页。
 */
export default async function AdminGroupLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await rejectNonAdminSiteUserFromAdmin();

  return <AdminAuthProvider>{children}</AdminAuthProvider>;
}
