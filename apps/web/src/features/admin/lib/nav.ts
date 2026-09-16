import {
  ClipboardList,
  FileText,
  HardDrive,
  LayoutDashboard,
  MessageSquare,
  ScrollText,
  Settings,
  Share2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** 仅超级管理员需要的入口。隐藏不等于禁止,后端仍会校验。 */
  superAdmin?: boolean;
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { href: '/admin', label: '仪表盘', icon: LayoutDashboard, description: '全站统计与趋势' },
  { href: '/admin/users', label: '用户', icon: Users, description: '用户、店铺与商品' },
  { href: '/admin/posts', label: '帖子', icon: FileText, description: '隐藏、恢复、置顶与编辑' },
  { href: '/admin/comments', label: '评论', icon: MessageSquare, description: '隐藏、恢复与删除' },
  { href: '/admin/models', label: '模型', icon: Sparkles, description: '供应商、模型与选择策略' },
  { href: '/admin/content-rules', label: '内容规则', icon: ScrollText, description: '提示词、违禁与平台规则' },
  { href: '/admin/share', label: '分享', icon: Share2, description: '微信 / QQ 与分享域名' },
  { href: '/admin/tasks', label: '任务', icon: ClipboardList, description: '生成记录与失败原因' },
  { href: '/admin/storage', label: '存储', icon: HardDrive, description: '用量、配额与清理' },
  { href: '/admin/system', label: '系统', icon: Settings, description: '系统配置', superAdmin: true },
  { href: '/admin/audit', label: '审计', icon: Shield, description: '操作审计日志' },
  { href: '/admin/admins', label: '管理员', icon: SlidersHorizontal, description: '管理员账号', superAdmin: true },
];

export function activeAdminHref(pathname: string): string | null {
  if (pathname === '/admin' || pathname === '/admin/') return '/admin';
  const match = ADMIN_NAV_ITEMS.filter((item) => item.href !== '/admin').find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  return match?.href ?? null;
}
