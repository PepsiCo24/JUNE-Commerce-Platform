'use client';

import { AlertCircle, Check, CloudOff, LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/utils';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const COPY: Record<SaveState, string> = {
  idle: '尚未开始保存',
  dirty: '有未保存的修改',
  saving: '正在保存',
  saved: '已保存',
  error: '保存失败',
};

export function SaveStatus({
  state,
  savedAt,
  error,
  onRetry,
}: {
  state: SaveState;
  savedAt?: string | null;
  error?: string | null;
  onRetry?: () => void;
}): React.JSX.Element {
  const Icon =
    state === 'saving'
      ? LoaderCircle
      : state === 'saved'
        ? Check
        : state === 'error'
          ? AlertCircle
          : CloudOff;

  return (
    <div
      role="status"
      className={cn(
        'inline-flex items-center gap-1.5 text-xs',
        state === 'error' ? 'text-state-danger-fg' : 'text-fg-muted',
      )}
    >
      <Icon size={12} aria-hidden className={state === 'saving' ? 'animate-spin' : undefined} />
      <span>
        {state === 'saved' && savedAt ? `${COPY[state]} · ${formatRelativeTime(savedAt)}` : COPY[state]}
        {state === 'error' && error ? `：${error}` : null}
      </span>
      {state === 'error' && onRetry ? (
        <button type="button" className="underline-offset-2 hover:underline" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
