'use client';

import { BrandLogo } from '@june/brand';
import { BRAND_FULL_NAME } from '@june/shared';
import { LogOut, Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';

import { useAdminAuth } from '@/features/admin/providers/admin-auth-provider';
import { ADMIN_NAV_ITEMS, activeAdminHref } from '@/features/admin/lib/nav';
import { LoadingState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

export function AdminShell({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div data-theme="light" className="flex min-h-dvh flex-col bg-bg text-fg">
      <AdminChrome>
        <Suspense fallback={<LoadingState message="加载管理页" />}>{children}</Suspense>
      </AdminChrome>
    </div>
  );
}

function AdminChrome({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, logout } = useAdminAuth();
  const pathname = usePathname();
  const active = activeAdminHref(pathname);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const visibleNav = ADMIN_NAV_ITEMS.filter((item) => !item.superAdmin || user?.isSuperAdmin);
  const activeItem = visibleNav.find((item) => item.href === active);

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-border-default bg-bg/95 px-4 py-3 backdrop-blur md:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label="打开管理导航"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={20} />
        </Button>
        <Link href="/admin" aria-label={BRAND_FULL_NAME}>
          <BrandLogo variant="horizontal" theme="light" size="sm" />
        </Link>
        <span className="ml-auto truncate text-sm text-fg-muted">{activeItem?.label ?? '管理站'}</span>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen} side="left" theme="light" title="管理站导航">
        <NavList items={visibleNav} active={active} onNavigate={() => setDrawerOpen(false)} />
      </Sheet>

      <aside className="hidden w-60 shrink-0 border-r border-border-default bg-bg-elevated md:flex md:flex-col xl:w-64">
        <div className="border-b border-border-default px-4 py-5">
          <Link href="/admin" aria-label={BRAND_FULL_NAME} className="block">
            <BrandLogo variant="horizontal" theme="light" size="sm" />
          </Link>
          <p className="mt-2 text-xs text-fg-subtle">管理站</p>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <NavList items={visibleNav} active={active} />
        </div>
        <div className="border-t border-border-default p-4">
          <p className="truncate text-sm font-medium text-fg">{user?.displayName}</p>
          <p className="truncate text-xs text-fg-muted">{user?.email}</p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 w-full justify-start"
            iconLeft={<LogOut size={16} />}
            onClick={() => void logout()}
          >
            退出管理站
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="hidden items-center justify-between gap-3 border-b border-border-default px-6 py-3 md:flex lg:px-8">
          <div>
            <p className="text-sm font-medium text-fg">{activeItem?.label ?? '管理站'}</p>
            <p className="text-xs text-fg-subtle">{activeItem?.description ?? BRAND_FULL_NAME}</p>
          </div>
          <div className="flex items-center gap-3">
            <p className="truncate text-sm text-fg-muted">{user?.displayName}</p>
            <Button variant="ghost" size="sm" iconLeft={<LogOut size={16} />} onClick={() => void logout()}>
              退出
            </Button>
          </div>
        </header>
        <main id="main" className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function NavList({
  items,
  active,
  onNavigate,
}: {
  items: typeof ADMIN_NAV_ITEMS;
  active: string | null;
  onNavigate?: () => void;
}): React.JSX.Element {
  return (
    <nav aria-label="管理站导航">
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
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
                  isActive ? 'bg-accent-surface text-accent' : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
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
