import { BrandLogo } from '@june/brand';
import { BRAND_FULL_NAME } from '@june/shared';
import Link from 'next/link';

import { SiteFooter } from './site-footer';

/** 未登录访问公开帖子时的浅色外壳 */
export function GuestShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-theme="light" className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="border-b border-border-default bg-bg-elevated/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[90rem] items-center justify-between px-4 sm:px-6">
          <Link href="/login" aria-label={BRAND_FULL_NAME}>
            <BrandLogo variant="horizontal" theme="light" size="sm" title={BRAND_FULL_NAME} />
          </Link>
          <div className="flex items-center gap-3 text-sm">
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
      <SiteFooter theme="light" />
    </div>
  );
}
