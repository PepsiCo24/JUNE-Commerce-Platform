'use client';

import { AlertTriangle, Inbox, Lock, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { describeError } from '@/lib/api/errors';
import { ApiError } from '@/lib/api/errors';

export function LoadingState({
  message = '加载中',
  className,
}: {
  message?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="status"
      className={cn('flex min-h-40 flex-col items-center justify-center gap-3 py-10 text-fg-muted', className)}
    >
      <Spinner size={22} />
      <p className="text-sm">{message}</p>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex min-h-48 flex-col items-center justify-center gap-3 px-4 py-12 text-center', className)}>
      <div className="flex size-12 items-center justify-center rounded-full bg-surface text-fg-subtle" aria-hidden>
        {icon ?? <Inbox size={22} />}
      </div>
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {description ? <div className="max-w-md text-sm leading-relaxed text-fg-muted">{description}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
  title = '加载失败',
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  title?: string;
}): React.JSX.Element {
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  return (
    <div
      role="alert"
      className={cn(
        'flex min-h-48 flex-col items-center justify-center gap-3 px-4 py-12 text-center',
        className,
      )}
    >
      <div
        className="flex size-12 items-center justify-center rounded-full bg-state-danger-bg text-state-danger-fg"
        aria-hidden
      >
        <AlertTriangle size={22} />
      </div>
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      <p className="max-w-md text-sm leading-relaxed text-fg-muted">{describeError(error)}</p>
      {requestId ? <p className="text-xs text-fg-subtle">请求编号 {requestId}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" iconLeft={<RefreshCw size={14} />} onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function ForbiddenState({
  message = '没有权限查看此内容，请先登录或换用有权限的账号。',
  className,
}: {
  message?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <EmptyState
      icon={<Lock size={22} />}
      title="无法访问"
      description={message}
      className={className}
    />
  );
}
