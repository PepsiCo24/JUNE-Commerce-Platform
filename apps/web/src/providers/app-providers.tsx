'use client';

import type { SessionUser } from '@june/shared';
import { Toaster } from 'sonner';
import type { ReactNode } from 'react';

import { ConfirmProvider } from '@/components/feedback/confirm-dialog';

import { AuthProvider } from './auth-provider';
import { PreferencesProvider } from './preferences-provider';
import { QueryProvider } from './query-provider';
import { SseProvider } from './sse-provider';

/**
 * 全局 Provider 组合。顺序有依赖关系:
 *   Preferences(无依赖)
 *     → Query(数据层)
 *       → Auth(需要 api 客户端,登录态决定是否建立 SSE)
 *         → Sse(需要登录态)
 */
export function AppProviders({
  children,
  initialUser = null,
}: {
  children: ReactNode;
  initialUser?: SessionUser | null;
}): React.JSX.Element {
  return (
    <PreferencesProvider>
      <QueryProvider>
        <AuthProvider initialUser={initialUser}>
          <SseProvider>
            <ConfirmProvider>
            {children}
            <Toaster
              position="top-center"
              // 使用设计系统的语义变量,深浅场景自动适配
              toastOptions={{
                style: {
                  background: 'var(--bg-elevated)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  boxShadow: 'var(--shadow-card)',
                },
              }}
              closeButton
              duration={4000}
            />
            </ConfirmProvider>
          </SseProvider>
        </AuthProvider>
      </QueryProvider>
    </PreferencesProvider>
  );
}
