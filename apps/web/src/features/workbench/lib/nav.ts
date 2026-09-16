/**
 * 工作台导航项。图标统一来自 lucide-react,不用 emoji 充当功能图标。
 */

import {
  HardDrive,
  History,
  ImagePlus,
  KeyRound,
  type LucideIcon,
  Network,
  Package,
  PenLine,
  Store,
} from 'lucide-react';

export interface WorkbenchNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const WORKBENCH_NAV_ITEMS: WorkbenchNavItem[] = [
  { href: '/workbench/image', label: '生图', icon: ImagePlus, description: '参考图与提示词生成商品图' },
  { href: '/workbench/copy', label: '文案', icon: PenLine, description: '标题与正文生成与内容检查' },
  { href: '/workbench/shops', label: '店铺', icon: Store, description: '主子店铺与继承关系管理' },
  { href: '/workbench/shops/graph', label: '店铺关系图', icon: Network, description: '主子店铺结构可视化' },
  { href: '/workbench/products', label: '商品', icon: Package, description: '商品资料与 CSV 批量导入' },
  { href: '/workbench/credentials', label: '凭据', icon: KeyRound, description: '店铺账号密码(需重新验证)' },
  { href: '/workbench/tasks', label: '任务记录', icon: History, description: '历史生成任务与结果回看' },
  { href: '/workbench/storage', label: '存储', icon: HardDrive, description: '用量、配额与增长' },
];

/**
 * 当前激活项。
 * 取"匹配到的最长 href",这样 /workbench/shops/graph 不会把「店铺」也点亮。
 */
export function activeNavHref(pathname: string): string | null {
  let matched: string | null = null;
  for (const item of WORKBENCH_NAV_ITEMS) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!matched || item.href.length > matched.length) matched = item.href;
    }
  }
  return matched;
}
