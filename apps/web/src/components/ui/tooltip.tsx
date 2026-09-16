'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { CircleHelp } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 悬浮提示。Radix 的 Trigger 同时响应 hover 与 focus,键盘用户也能读到内容。
 * 每个 Tooltip 自带 Provider,调用方不需要在上层再包一层。
 */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            collisionPadding={12}
            className="z-50 max-w-64 rounded-md border border-border-default bg-bg-elevated px-2 py-1.5 text-xs leading-relaxed text-fg shadow-md"
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/** 统计口径说明用的问号图标 + 悬浮说明 */
export function InfoHint({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        // 图标按钮必须有可读名称
        aria-label="查看说明"
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-colors duration-150 hover:text-fg',
          className,
        )}
      >
        <CircleHelp aria-hidden="true" className="size-4" />
      </button>
    </Tooltip>
  );
}
