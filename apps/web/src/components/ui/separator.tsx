import { cn } from '@/lib/utils';

/**
 * 分隔线。
 * 用原生 div + role="separator" 而不是 @radix-ui/react-separator,
 * 是为了让这个纯展示组件保持 RSC 可渲染(Radix 包内部带 'use client')。
 */
export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'shrink-0 bg-border-default',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
    />
  );
}
