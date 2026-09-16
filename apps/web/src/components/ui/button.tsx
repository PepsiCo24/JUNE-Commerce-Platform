'use client';

import { Slot } from '@radix-ui/react-slot';
import { forwardRef } from 'react';

import { cn } from '@/lib/utils';

import { Spinner } from './progress';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** true 时显示内联 spinner 并自动 disabled */
  loading?: boolean;
  /** 左右图标(lucide-react 组件元素) */
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  /** 用 Radix Slot 渲染为子元素(用于包 <Link>) */
  asChild?: boolean;
  fullWidth?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'bg-surface text-fg border border-border-default hover:bg-surface-hover',
  ghost: 'text-fg-muted hover:bg-surface-hover hover:text-fg',
  outline: 'border border-border-strong text-fg hover:bg-surface-hover',
  danger: 'bg-state-danger-fg text-bg hover:bg-state-danger-fg/90',
  link: 'text-accent underline-offset-4 hover:underline',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-sm px-3 text-sm',
  md: 'h-10 gap-2 rounded-md px-4 text-sm',
  lg: 'h-12 gap-2 rounded-md px-5 text-base',
  icon: 'h-10 w-10 rounded-md p-0',
};

/** link 变体不需要按钮盒子的高度与内边距 */
const LINK_SIZE_CLASS = 'h-auto gap-1 rounded-sm p-0 text-sm';

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    iconLeft,
    iconRight,
    asChild = false,
    fullWidth = false,
    className,
    children,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  const classes = cn(
    'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors duration-150',
    'disabled:pointer-events-none disabled:opacity-50',
    variant === 'link' ? LINK_SIZE_CLASS : SIZE_CLASS[size],
    VARIANT_CLASS[variant],
    fullWidth && 'w-full',
    className,
  );

  // asChild 时子元素自己负责内容结构,不注入 spinner / 图标,否则会破坏 Slot 的单子元素约束
  if (asChild) {
    return (
      <Slot className={classes} {...rest}>
        {children}
      </Slot>
    );
  }

  const spinnerSize = size === 'lg' ? 18 : 14;

  return (
    <button
      ref={ref}
      // 默认 button,避免放在 <form> 里意外触发提交
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={spinnerSize} /> : iconLeft}
      {children}
      {iconRight}
    </button>
  );
});
