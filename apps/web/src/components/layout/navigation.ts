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

/**
 * 路由 → 场景配色。
 *
 * 顶栏、页脚与页面主体必须处于同一个 `data-theme` 下,否则会出现"浅色社区页配深色顶栏"。
 * 组件本身只写语义类名(bg-bg-elevated / text-fg / border-border-default ...),
 * 具体取哪套色值完全由这里返回的 data-theme 决定 —— 所以同一个顶栏能在两种场景复用。
 */
export function themeForPath(pathname: string): 'dark' | 'light' {
  // 社区(含公开帖子页)是浅色场景
  if (isActivePath(pathname, '/community') || isActivePath(pathname, '/p')) return 'light';
  // 首页、工作台、个人设置是深色场景
  return 'dark';
}
