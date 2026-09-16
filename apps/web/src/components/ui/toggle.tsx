'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { Check } from 'lucide-react';
import { useId } from 'react';

import { cn } from '@/lib/utils';

export function Switch({
  checked,
  onChange,
  disabled,
  id,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      id={id}
      aria-label={ariaLabel}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      className={cn(
        'inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border-default p-0.5 transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-accent-border data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-active',
      )}
    >
      {/* 只动 transform,避免布局属性动画 */}
      <SwitchPrimitive.Thumb
        className={cn(
          'block size-4.5 rounded-full bg-bg-elevated shadow-sm transition-transform duration-150',
          'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export function Checkbox({
  checked,
  onChange,
  disabled,
  id,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: React.ReactNode;
}): React.JSX.Element {
  const generatedId = useId();
  const controlId = id ?? `checkbox-${generatedId}`;

  const box = (
    <CheckboxPrimitive.Root
      id={controlId}
      checked={checked}
      // Radix 的 CheckedState 含 'indeterminate',契约只需布尔
      onCheckedChange={(next) => onChange(next === true)}
      disabled={disabled}
      className={cn(
        'inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm border transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:border-border-strong data-[state=unchecked]:bg-surface',
      )}
    >
      <CheckboxPrimitive.Indicator>
        <Check aria-hidden="true" className="size-3.5 text-accent-fg" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );

  if (!label) return box;

  return (
    <div className="flex items-center gap-2">
      {box}
      <label htmlFor={controlId} className={cn('text-sm text-fg', disabled && 'opacity-50')}>
        {label}
      </label>
    </div>
  );
}

export function RadioGroup<T extends string>({
  value,
  onChange,
  options,
  name,
  orientation = 'vertical',
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean }>;
  name: string;
  orientation?: 'horizontal' | 'vertical';
}): React.JSX.Element {
  return (
    <RadioGroupPrimitive.Root
      name={name}
      value={value}
      // Radix 只知道 string,这里收窄回调用方的字面量联合类型
      onValueChange={(next) => onChange(next as T)}
      orientation={orientation}
      className={cn('flex gap-3', orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap items-center')}
    >
      {options.map((option) => {
        const itemId = `${name}-${option.value}`;
        return (
          <div key={option.value} className="flex items-start gap-2">
            <RadioGroupPrimitive.Item
              id={itemId}
              value={option.value}
              disabled={option.disabled}
              className={cn(
                'mt-0.5 inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border transition-colors duration-150',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'data-[state=checked]:border-accent data-[state=unchecked]:border-border-strong bg-surface',
              )}
            >
              <RadioGroupPrimitive.Indicator className="block size-2 rounded-full bg-accent" />
            </RadioGroupPrimitive.Item>

            <div className="min-w-0">
              <label htmlFor={itemId} className={cn('block text-sm text-fg', option.disabled && 'opacity-50')}>
                {option.label}
              </label>
              {option.description && <p className="text-xs text-fg-muted">{option.description}</p>}
            </div>
          </div>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}
