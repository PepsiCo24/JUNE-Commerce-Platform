import { cn } from '@/lib/utils';

/** 纯展示、无 hooks:可直接在 RSC 中渲染 */

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <div aria-hidden="true" className={cn('june-skeleton h-4 w-full', className)} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }): React.JSX.Element {
  const count = Math.max(1, lines);
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          key={index}
          // 最后一行短一些,更接近真实段落的视觉节奏
          className={index === count - 1 ? 'h-3.5 w-3/5' : 'h-3.5 w-full'}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn('space-y-3 rounded-lg border border-border-default bg-surface p-4', className)}
    >
      <Skeleton className="h-32 w-full rounded-md" />
      <Skeleton className="h-4 w-2/3" />
      <SkeletonText lines={2} />
    </div>
  );
}
