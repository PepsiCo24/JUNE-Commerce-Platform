'use client';

import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';

import { cn } from '@/lib/utils';

export type DropdownMenuItemSpec =
  | {
      type: 'item';
      label: React.ReactNode;
      icon?: React.ReactNode;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
    }
  | { type: 'separator' }
  | { type: 'label'; label: React.ReactNode };

/**
 * 下拉菜单。键盘导航、类型提前定位、点击外部关闭由 Radix 提供。
 * theme 默认 'dark':菜单走 Portal,拿不到页面容器上的 data-theme。
 */
export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  theme = 'dark',
}: {
  trigger: React.ReactNode;
  items: DropdownMenuItemSpec[];
  align?: 'start' | 'center' | 'end';
  theme?: 'dark' | 'light';
}): React.JSX.Element {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>

      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          data-theme={theme}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-50 min-w-44 max-w-64 overflow-hidden rounded-lg border border-border-default bg-bg-elevated p-1 text-fg shadow-lg',
          )}
        >
          {items.map((item, index) => {
            if (item.type === 'separator') {
              return (
                <MenuPrimitive.Separator key={`separator-${index}`} className="my-1 h-px bg-border-default" />
              );
            }

            if (item.type === 'label') {
              return (
                <MenuPrimitive.Label key={`label-${index}`} className="px-2 py-1.5 text-xs text-fg-subtle">
                  {item.label}
                </MenuPrimitive.Label>
              );
            }

            return (
              <MenuPrimitive.Item
                key={`item-${index}`}
                disabled={item.disabled}
                onSelect={() => item.onSelect()}
                className={cn(
                  'flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none',
                  'data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                  item.danger ? 'text-state-danger-fg' : 'text-fg',
                )}
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
              </MenuPrimitive.Item>
            );
          })}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
