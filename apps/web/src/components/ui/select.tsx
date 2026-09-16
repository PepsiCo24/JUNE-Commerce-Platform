'use client';

import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled,
  invalid,
  id,
  className,
  'aria-label': ariaLabel,
}: {
  value: string | null;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}): React.JSX.Element {
  return (
    // Radix 不接受空字符串作为受控值,null 统一转成 undefined(未选中)
    <SelectPrimitive.Root value={value ?? undefined} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-md border bg-surface px-3 text-sm text-fg',
          'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
          'data-[placeholder]:text-fg-subtle',
          invalid ? 'border-state-danger-border' : 'border-border-default hover:border-border-strong',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        {/* 下拉面板走 Portal,继承 <body> 的深色语义变量;浅色页面里由调用方所在容器决定视觉一致性 */}
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border-default bg-bg-elevated text-fg shadow-lg"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'flex cursor-pointer select-none items-start gap-2 rounded-md px-2 py-1.5 text-sm outline-none',
                  'data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                  <SelectPrimitive.ItemIndicator>
                    <Check aria-hidden="true" className="size-3.5 text-accent" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <span className="min-w-0">
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  {option.description && <span className="block text-xs text-fg-muted">{option.description}</span>}
                </span>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
