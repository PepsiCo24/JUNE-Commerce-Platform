'use client';

import type { SessionUser } from '@june/shared';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { SiteFooter } from './site-footer';
import { themeForPath } from './navigation';
import { TopBar } from './top-bar';

/**
 * 登录后的应用外壳:顶栏 + 主内容 + 页脚。
 *
 * Logo / 顶栏配色跟路由场景(首页与工作台深色、社区浅色),
 * 与用户「日间/夜间」偏好解耦 —— 避免深色场景上画出浅色稿的深色墨水。
 */
export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const theme = themeForPath(pathname);

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg" data-scene={theme}>
      <TopBar user={user} theme={theme} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter theme={theme} />
    </div>
  );
}
