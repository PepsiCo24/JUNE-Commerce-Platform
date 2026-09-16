'use client';

import type { SessionUser } from '@june/shared';
import type { ReactNode } from 'react';

import { useTheme } from '@/providers/theme-provider';

import { SiteFooter } from './site-footer';
import { TopBar } from './top-bar';

/**
 * 登录后的应用外壳:顶栏 + 主内容 + 页脚。
 * 主题由 ThemeProvider 统一写入 html[data-theme],此处只负责布局。
 */
export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }): React.JSX.Element {
  const { resolved: theme } = useTheme();

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <TopBar user={user} theme={theme} />
      {/* 根布局的「跳到主要内容」锚点 */}
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter theme={theme} />
    </div>
  );
}
