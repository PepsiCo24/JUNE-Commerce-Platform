'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiError, NetworkError } from '@/lib/api/errors';

/**
 * React Query 配置。
 *
 * 重试策略要点:
 *  - 权限类错误(401/403)与校验错误不重试,重试没有意义还会放大压力。
 *  - 429 与 5xx 有限重试并指数退避,配合后端的限流策略。
 *  - 变更(mutation)默认不自动重试:AI 提交等接口涉及付费调用,
 *    重复提交必须由调用方显式携带幂等键来保证安全。
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 列表数据 30 秒内视为新鲜,减少 50 人在线时的重复请求
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof NetworkError) return failureCount < 2;
          if (error instanceof ApiError) return error.isRetryable && failureCount < 2;
          return false;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // 每个浏览器会话一个实例;放在 state 里避免 React 严格模式下重复创建
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
