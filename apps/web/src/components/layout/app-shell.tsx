'use client';

import type { SessionUser } from '@june/shared';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { SiteFooter } from './site-footer';
import { TopBar } from './top-bar';
import { themeForPath } from './navigation';

/**
 * 登录后的应用外壳:顶栏 + 主内容 + 页脚。
 *
 * 为什么是客户端组件:顶栏需要当前路径来高亮导航,也需要它来决定整屏的 `data-theme`
 * (社区浅色 / 首页与工作台深色)。`data-theme` 放在最外层,顶栏、内容、页脚同属一个场景,
 * 子路由如果还要局部反色,可以在自己的容器上再写一层 `data-theme` 覆盖。
 */
export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const theme = themeForPath(pathname);

  return (
    <div data-theme={theme} className="flex min-h-dvh flex-col bg-bg text-fg">
      <TopBar user={user} theme={theme} />
      {/* 根布局的「跳到主要内容」锚点 */}
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter theme={theme} />
    </div>
  );
}
