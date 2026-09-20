import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** 紧凑卡片骨架,与 PostCard 对齐。 */
export function PostCardSkeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-lg border border-border-default bg-bg-elevated px-3 py-2',
        className,
      )}
    >
      <div className="flex gap-2.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-2.5 w-8" />
            <Skeleton className="h-2.5 w-10" />
          </div>
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
          <div className="flex items-center gap-3 pt-0.5">
            <Skeleton className="h-3 w-7" />
            <Skeleton className="h-3 w-7" />
            <Skeleton className="h-3 w-5" />
          </div>
        </div>
        <Skeleton className="size-14 shrink-0 rounded-md" />
      </div>
    </div>
  );
}

export function PostGridSkeleton({ count = 6 }: { count?: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: count }, (_, index) => (
        <PostCardSkeleton key={index} />
      ))}
    </div>
  );
}
