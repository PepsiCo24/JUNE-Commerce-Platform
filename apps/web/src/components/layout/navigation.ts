import { LayoutPanelLeft, MessagesSquare, Settings, type LucideIcon } from 'lucide-react';

/**
 * 应用外壳的导航定义。顶栏与移动端抽屉共用同一份,避免两处不一致。
 *
 * 这里只描述"入口",不代表权限:后端才是判定方。
 */

export interface NavItem {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const MAIN_NAV: NavItem[] = [
  { href: '/community', label: '社区', description: '浏览与发布帖子', icon: MessagesSquare },
  { href: '/workbench', label: '工作台', description: '生图、文案与店铺商品', icon: LayoutPanelLeft },
];

/** 仅出现在移动端抽屉里的次级入口(桌面端在用户菜单中) */
export const SECONDARY_NAV: NavItem[] = [
  { href: '/settings', label: '个人设置', description: '资料、密码与偏好', icon: Settings },
];

export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
