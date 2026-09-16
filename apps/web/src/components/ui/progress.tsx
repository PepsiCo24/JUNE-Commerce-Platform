import { cn } from '@/lib/utils';

/**
 * 进度条与旋转指示器。
 *
 * 这个文件故意不加 'use client':两个组件都没有 hooks 与事件处理,
 * 动效完全由 CSS(globals.css 里的 june-shimmer / Tailwind animate-spin)驱动,
 * 因此可以直接在 RSC 里渲染,不产生客户端 JS。
 * 减少动态效果也由 globals.css 的 [data-reduced-motion] / prefers-reduced-motion
 * 规则统一降级,不需要在组件里读 useReducedMotion()。
 */

interface ProgressProps {
  /** null 表示"进度未知"。此时只展示不确定态条纹,绝不显示编造的百分比 */
  value: number | null;
  className?: string;
  'aria-label'?: string;
}

export function Progress({ value, className, 'aria-label': ariaLabel }: ProgressProps): React.JSX.Element {
  const indeterminate = value === null;
  const percent = indeterminate ? 0 : Math.min(100, Math.max(0, Math.round(value)));

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-label={ariaLabel ?? (indeterminate ? '处理中,进度未知' : '进度')}
        aria-valuemin={0}
        aria-valuemax={100}
        // 不确定态不给 aria-valuenow:屏幕阅读器会读成"忙碌",而不是一个假的百分比
        aria-valuenow={indeterminate ? undefined : percent}
        aria-busy={indeterminate || undefined}
        className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-active"
      >
        {indeterminate ? (
          <div
            className="absolute inset-0"
            style={{
              // 语义变量而非具体色值;背景位置动画由 june-shimmer 提供
              backgroundImage:
                'repeating-linear-gradient(115deg, var(--accent) 0 10px, var(--accent-surface) 10px 20px)',
              backgroundSize: '200% 100%',
              animation: 'june-shimmer 1.1s linear infinite',
            }}
          />
        ) : (
          <div
            className="h-full rounded-full bg-accent"
            // 宽度是数据驱动的百分比,只能走内联样式
            style={{ width: `${percent}%` }}
          />
        )}
      </div>

      {/* 只有拿到真实百分比才显示数字 */}
      {!indeterminate && <span className="tabular shrink-0 text-xs text-fg-muted">{percent}%</span>}
    </div>
  );
}

interface SpinnerProps {
  size?: number;
  className?: string;
}

export function Spinner({ size = 16, className }: SpinnerProps): React.JSX.Element {
  return (
    <svg
      className={cn('shrink-0 animate-spin', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" opacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
