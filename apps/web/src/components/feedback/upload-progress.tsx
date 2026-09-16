'use client';

import { RotateCcw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

export interface UploadItem {
  id: string;
  name: string;
  percent: number | null;
  status: 'pending' | 'uploading' | 'confirming' | 'done' | 'error';
  error?: string;
}

const STAGE_LABEL: Record<UploadItem['status'], string> = {
  pending: '等待上传',
  uploading: '正在上传',
  confirming: '正在校验',
  done: '已完成',
  error: '失败',
};

export function UploadProgressList({
  items,
  onRemove,
  onRetry,
}: {
  items: UploadItem[];
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
}): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li
          key={item.id}
          className={cn(
            'rounded-md border border-border-default bg-surface px-3 py-2',
            item.status === 'error' && 'border-state-danger-border',
          )}
        >
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm text-fg">{item.name}</p>
            <span className="shrink-0 text-xs text-fg-muted">{STAGE_LABEL[item.status]}</span>
            {item.status === 'error' && onRetry ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`重试上传 ${item.name}`}
                onClick={() => onRetry(item.id)}
              >
                <RotateCcw size={14} />
              </Button>
            ) : null}
            {onRemove && item.status !== 'uploading' && item.status !== 'confirming' ? (
              <Button variant="ghost" size="icon" aria-label={`移除 ${item.name}`} onClick={() => onRemove(item.id)}>
                <X size={14} />
              </Button>
            ) : null}
          </div>
          {item.status === 'uploading' || item.status === 'confirming' ? (
            <Progress value={item.percent} className="mt-2" aria-label={`${item.name} 上传进度`} />
          ) : null}
          {item.error ? <p className="mt-1 text-xs text-state-danger-fg">{item.error}</p> : null}
        </li>
      ))}
    </ul>
  );
}
