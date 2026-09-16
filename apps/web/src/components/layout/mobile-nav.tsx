'use client';

import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

import { MAIN_NAV, SECONDARY_NAV, isActivePath } from './navigation';

/**
 * 移动端(< md)折叠导航。
 * 顶栏在窄屏只保留 Logo、连接状态与头像,主导航收进抽屉。
 */
export function MobileNav({ theme }: { theme: 'dark' | 'light' }): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // 路由变化后自动收起,避免跳转后抽屉还盖在页面上
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="打开导航菜单"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border-default text-fg transition-colors hover:bg-surface-hover md:hidden"
      >
        <Menu size={18} aria-hidden="true" />
      </button>

      <Sheet open={open} onOpenChange={setOpen} side="left" title="导航" theme={theme}>
        <nav aria-label="主导航" className="flex flex-col gap-1 py-2">
          {[...MAIN_NAV, ...SECONDARY_NAV].map((item) => {
            const active = isActivePath(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-start gap-3 rounded-lg px-3 py-3 transition-colors',
                  active ? 'bg-accent-surface text-accent' : 'text-fg hover:bg-surface-hover',
                )}
              >
                <Icon size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{item.label}</span>
                  <span className="block text-xs text-fg-muted">{item.description}</span>
                </span>
              </Link>
            );
          })}
        </nav>
      </Sheet>
    </>
  );
}
