'use client';

import * as PopoverPrimitive from '@radix-ui/react-popover';

/**
 * 浮层。焦点管理、ESC 关闭、点击外部关闭由 Radix 提供。
 * theme 默认 'dark':内容走 Portal,拿不到页面容器上的 data-theme。
 */
export function Popover({
  trigger,
  children,
  align = 'center',
  theme = 'dark',
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  theme?: 'dark' | 'light';
}): React.JSX.Element {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-theme={theme}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-72 max-w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border-default bg-bg-elevated p-3 text-sm text-fg shadow-lg"
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
