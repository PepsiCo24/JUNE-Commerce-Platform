'use client';

import { BrandLogo } from '@june/brand';
import { BRAND_FULL_NAME } from '@june/shared';
import Link from 'next/link';

import { ThemeToggle } from '@/components/system/theme-toggle';
import { useTheme } from '@/providers/theme-provider';

import { SiteFooter } from './site-footer';

/** 未登录访问公开内容时的外壳,主题与全站同步 */
export function GuestShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { resolved: theme } = useTheme();

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="sticky top-0 z-50 border-b border-border-default bg-bg-elevated/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[90rem] items-center justify-between px-4 sm:px-6">
          <Link href="/login" aria-label={BRAND_FULL_NAME}>
            <BrandLogo variant="horizontal" theme={theme} size="sm" title={BRAND_FULL_NAME} />
          </Link>
          <div className="flex items-center gap-2 text-sm sm:gap-3">
            <ThemeToggle />
            <Link href="/login" className="text-fg-muted hover:text-fg">
              登录
            </Link>
            <Link href="/register" className="rounded-md bg-accent px-3 py-1.5 text-accent-fg">
              注册
            </Link>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter theme={theme} />
    </div>
  );
}
