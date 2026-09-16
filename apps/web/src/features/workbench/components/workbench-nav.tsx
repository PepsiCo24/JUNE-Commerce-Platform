'use client';

import { BrandLogo } from '@june/brand';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

import { activeNavHref, WORKBENCH_NAV_ITEMS } from '../lib/nav';

/**
 * 工作台导航。
 *
 * 桌面(≥md):常驻左侧竖向导航,顶部是精简品牌组合。
 * 移动(<md):折叠为顶部条 + Sheet 抽屉,路由变化后自动收起。
 */
export function WorkbenchNav(): React.JSX.Element {
  const pathname = usePathname();
  const active = activeNavHref(pathname);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 跳转后收起抽屉,否则用户会看到导航盖住刚打开的页面
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const activeItem = WORKBENCH_NAV_ITEMS.find((item) => item.href === active);

  return (
    <>
      {/* ---- 移动端上下文条:贴在全局 TopBar 下方,去掉重复 Logo ---- */}
      <div className="sticky top-14 z-30 flex items-center gap-3 border-b border-border-default bg-bg/95 px-4 py-2.5 backdrop-blur md:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label="打开工作台导航"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={20} />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {activeItem?.label ?? '工作台'}
        </span>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen} side="left" theme="dark" title="工作台导航">
        <NavList active={active} onNavigate={() => setDrawerOpen(false)} />
      </Sheet>

      {/* ---- 桌面端侧边导航 ---- */}
      <aside className="hidden w-60 shrink-0 border-r border-border-default px-4 py-6 md:block xl:w-64">
        <div className="mb-6 px-2">
          <Link href="/workbench/image" aria-label="JUNE 工作台">
            <BrandLogo variant="horizontal" theme="dark" size="sm" />
          </Link>
        </div>
        <NavList active={active} />
      </aside>
    </>
  );
}

function NavList({ active, onNavigate }: { active: string | null; onNavigate?: () => void }): React.JSX.Element {
  return (
    <nav aria-label="工作台导航">
      <ul className="flex flex-col gap-1">
        {WORKBENCH_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.href === active;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={isActive ? 'page' : undefined}
                title={item.description}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent-surface text-accent'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                )}
              >
                <Icon size={18} aria-hidden />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
