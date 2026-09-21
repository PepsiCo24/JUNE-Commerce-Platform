'use client';

import { BrandLogo } from '@june/brand';
import type { SessionUser } from '@june/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/auth-provider';

import { ThemeToggle } from '@/components/system/theme-toggle';

import { ConnectionStatus } from './connection-status';
import { MobileNav } from './mobile-nav';
import { MAIN_NAV, isActivePath } from './navigation';
import { UserMenu } from './user-menu';

/**
 * 应用顶栏。社区与工作台共用同一个组件。
 *
 * 配色不写死:这里只用语义变量类名(bg-bg-elevated / text-fg / border-border-default ...),
 * 实际取值由 ThemeProvider 设置的 `data-theme` 决定,
 * 因此同一份代码在两种场景下都满足对比度要求,不需要两套顶栏。
 */
export function TopBar({
  user: initialUser,
  theme,
}: {
  /** 由 `(app)/layout.tsx` 服务端取到的用户,作为首屏初始值,避免闪烁 */
  user: SessionUser;
  theme: 'dark' | 'light';
}): React.JSX.Element {
  const pathname = usePathname();
  // AuthProvider 自己也会探测 /auth/me;探测完成前先用服务端传入的初始值,两者最终一致
  const { user: liveUser } = useAuth();
  const user = liveUser ?? initialUser;

  return (
    <header className="sticky top-0 z-50 border-b border-border-default bg-bg-elevated/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <MobileNav theme={theme} />

        <Link href="/" className="flex shrink-0 items-center rounded-md" aria-label="返回首页">
          {/* Logo 的深浅版本跟随当前主题;所有标识只能来自 BrandLogo */}
          <BrandLogo variant="horizontal" theme={theme} size={36} title="返回首页" />
        </Link>

        <nav aria-label="主导航" className="ml-2 hidden shrink-0 items-center gap-1 md:flex">
          {MAIN_NAV.map((item) => {
            const active = isActivePath(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-accent-surface text-accent'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* 社区大厅等页面可把搜索/筛选 Portal 到这里,避免占主列纵向空间 */}
        <div id="app-topbar-center" className="mx-2 hidden min-w-0 flex-1 md:block" />

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <ConnectionStatus />
          <UserMenu user={user} theme={theme} />
        </div>
      </div>
    </header>
  );
}
