'use client';

import { RefreshCw, Wifi, WifiOff } from 'lucide-react';

import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useSse } from '@/providers/sse-provider';

/**
 * 实时连接状态。
 *
 * 不假装实时:SSE 断了就明说,降级轮询了也明说延迟变长,
 * 避免用户以为看到的是最新数据。
 */

const STATUS = {
  connecting: {
    icon: RefreshCw,
    label: '正在连接实时更新',
    tooltip: '正在建立实时连接,稍后数据会自动同步',
    className: 'text-fg-subtle',
    spin: true,
  },
  sse: {
    icon: Wifi,
    label: '实时更新已连接',
    tooltip: '实时更新已连接,任务与配置变更会即时同步',
    className: 'text-accent',
    spin: false,
  },
  polling: {
    icon: RefreshCw,
    label: '实时更新降级中',
    tooltip: '实时更新降级中:当前改为定时轮询,数据同步会有十几秒延迟',
    className: 'text-state-warning-fg',
    spin: false,
  },
  offline: {
    icon: WifiOff,
    label: '连接中断',
    tooltip: '连接中断,正在自动重连;期间页面数据可能不是最新的',
    className: 'text-state-danger-fg',
    spin: false,
  },
} as const;

export function ConnectionStatus({ className }: { className?: string }): React.JSX.Element {
  const { transport } = useSse();
  const status = STATUS[transport];
  const Icon = status.icon;
  const showLabel = transport !== 'sse';

  return (
    <Tooltip content={status.tooltip}>
      <span
        role="status"
        aria-label={status.label}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-full border border-border-default text-xs',
          showLabel ? 'px-2.5' : 'px-2',
          status.className,
          className,
        )}
      >
        <Icon size={14} aria-hidden="true" className={status.spin ? 'animate-spin' : undefined} />
        {/* SSE 已连接时只显示图标;连接中 / 轮询 / 离线在宽屏显示文案 */}
        {showLabel ? <span className="hidden lg:inline">{status.label}</span> : null}
      </span>
    </Tooltip>
  );
}
