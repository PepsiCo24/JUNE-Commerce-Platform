import { cn } from '@/lib/utils';

/** 卡片系列都是纯展示、无 hooks,可直接在 RSC 中渲染 */

export function Card({
  glass = false,
  interactive = false,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { glass?: boolean; interactive?: boolean }): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-lg',
        glass ? 'june-glass' : 'border border-border-default bg-surface',
        // interactive 只负责视觉反馈;role / tabIndex 由调用方按语义决定
        interactive && 'cursor-pointer transition-colors duration-150 hover:bg-surface-hover hover:border-border-strong',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex flex-col gap-1 p-4 sm:p-5', className)} {...rest} />;
}

export function CardTitle({
  as: Tag = 'h3',
  className,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: 'h1' | 'h2' | 'h3' | 'h4' }): React.JSX.Element {
  return <Tag className={cn('text-base font-semibold text-fg', className)} {...rest} />;
}

export function CardDescription({
  className,
  ...rest
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn('text-sm text-fg-muted', className)} {...rest} />;
}

export function CardContent({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('p-4 pt-0 sm:p-5 sm:pt-0', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-2 border-t border-border-default p-4 sm:px-5', className)}
      {...rest}
    />
  );
}
