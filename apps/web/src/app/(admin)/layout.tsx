import { AdminAuthProvider } from '@/features/admin/providers/admin-auth-provider';

/**
 * 管理站路由组外壳。浅色主题由控制台布局挂上;
 * 登录页自行使用深色容器。会话与站点完全独立。
 */
export default function AdminGroupLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <AdminAuthProvider>{children}</AdminAuthProvider>;
}
