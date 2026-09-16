import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

/**
 * 通用页头:面包屑 + 标题 + 描述 + 右侧操作区。
 *
 * 社区、工作台、管理站共用,签名在 docs/WEB_UI_CONTRACT.md 中固定,不要改。
 * 纯展示、无 hooks,因此服务端组件与客户端组件都能直接渲染。
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="面包屑">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {crumb.href && !isLast ? (
                    <Link href={crumb.href} className="rounded transition-colors hover:text-fg">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={isLast ? 'page' : undefined} className={isLast ? 'text-fg' : undefined}>
                      {crumb.label}
                    </span>
                  )}
                  {isLast ? null : <ChevronRight size={12} aria-hidden="true" className="text-fg-subtle" />}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}

      {/* 移动端标题与操作区上下堆叠,桌面端左右分布 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-fg sm:text-2xl">{title}</h1>
          {description ? <div className="mt-1 text-sm text-fg-muted">{description}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
