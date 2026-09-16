import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** 横向紧凑卡片骨架,高度约 160–180px,与 PostCard 对齐。 */
export function PostCardSkeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-h-[160px] flex-col gap-3 rounded-xl border border-border-default bg-bg-elevated p-[18px] sm:min-h-[170px] sm:p-5',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Skeleton className="size-7 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>

      <div className="flex flex-1 gap-3 sm:gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-4/5" />
          <SkeletonText lines={2} />
        </div>
        <Skeleton className="hidden h-24 w-36 shrink-0 rounded-md sm:block sm:h-[72px] sm:w-24" />
      </div>

      <div className="flex items-center gap-3 border-t border-border-default pt-3">
        <Skeleton className="h-4 w-10" />
        <Skeleton className="h-4 w-10" />
        <Skeleton className="h-4 w-12" />
      </div>
    </div>
  );
}

export function PostGridSkeleton({ count = 4 }: { count?: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      {Array.from({ length: count }, (_, index) => (
        <PostCardSkeleton key={index} />
      ))}
    </div>
  );
}
