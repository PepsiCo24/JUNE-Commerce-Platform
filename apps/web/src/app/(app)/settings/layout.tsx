'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { PageHeader } from '@/components/layout/page-header';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/settings/profile', label: '基本资料' },
  { href: '/settings/avatar', label: '头像设置' },
  { href: '/settings/security', label: '账户安全' },
  { href: '/settings/appearance', label: '外观设置' },
];

export default function SettingsLayout({ children }: { children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <PageHeader title="个人设置" description="管理资料、安全与界面偏好。" />
      <nav aria-label="设置分组" className="mb-6 flex flex-wrap gap-2 border-b border-border-default pb-3">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                active ? 'bg-accent-surface text-accent' : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
