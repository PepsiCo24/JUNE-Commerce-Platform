'use client';

import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '@/lib/utils';

/** 单值滑块。方向键 / PageUp / PageDown / Home / End 由 Radix 提供。 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  id,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}): React.JSX.Element {
  return (
    <SliderPrimitive.Root
      id={id}
      value={[value]}
      // Radix 支持多滑块,这里只取第一个值;拿不到时保持原值,不写入 undefined
      onValueChange={(next) => onChange(next[0] ?? value)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn('relative flex h-5 w-full touch-none select-none items-center', disabled && 'opacity-50')}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-active">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        className="block size-4 rounded-full border border-accent-border bg-accent shadow-sm disabled:pointer-events-none"
      />
    </SliderPrimitive.Root>
  );
}
