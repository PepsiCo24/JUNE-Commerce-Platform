'use client';

import { cn } from '@/lib/utils';

import { Skeleton } from './skeleton';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  /** 数字列右对齐 + tabular */
  numeric?: boolean;
  className?: string;
  /** 移动端隐藏该列 */
  hideOnMobile?: boolean;
}

function cellClass<T>(column: Column<T>): string {
  return cn(
    'px-3 py-2.5 text-sm align-middle',
    column.numeric && 'text-right tabular',
    // <md 直接不参与表格布局,窄屏不会被挤破
    column.hideOnMobile && 'hidden md:table-cell',
    column.className,
  );
}

/**
 * 数据表格。
 *
 * 布局约定:
 *  - 外层是横向滚动容器,列多时窄屏滚动而不破版;
 *  - 表头 sticky top-0 且带底色,长表格滚动时表头不丢
 *    (垂直滚动发生在这个容器内时最有效,调用方可通过 className 传 max-h-*);
 *  - loading 时渲染同样的列结构骨架行,表格总宽与表头位置不变,避免加载完成后的布局跳动。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyMessage = '暂无数据',
  onRowClick,
  skeletonRows = 5,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyMessage?: React.ReactNode;
  onRowClick?: (row: T) => void;
  /** 加载中时渲染的骨架行数 */
  skeletonRows?: number;
}): React.JSX.Element {
  const isEmpty = rows.length === 0 && !loading;
  const clickable = Boolean(onRowClick);

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border-default">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  cellClass(column),
                  'sticky top-0 z-10 whitespace-nowrap border-b border-border-default bg-bg-elevated py-2 text-xs font-medium text-fg-muted',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {loading &&
            Array.from({ length: Math.max(1, skeletonRows) }, (_, rowIndex) => (
              <tr key={`skeleton-${rowIndex}`} className="border-b border-border-default last:border-0">
                {columns.map((column) => (
                  <td key={column.key} className={cellClass(column)}>
                    <Skeleton className={cn('h-4', column.numeric ? 'ml-auto w-12' : 'w-4/5')} />
                  </td>
                ))}
              </tr>
            ))}

          {isEmpty && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-fg-muted">
                {emptyMessage}
              </td>
            </tr>
          )}

          {!loading &&
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                // 可点击行需要键盘等价操作,否则只有鼠标用户能用
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => onRowClick?.(row) : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          // 空格默认会滚动页面
                          event.preventDefault();
                          onRowClick?.(row);
                        }
                      }
                    : undefined
                }
                className={cn(
                  'border-b border-border-default last:border-0',
                  clickable && 'cursor-pointer transition-colors duration-150 hover:bg-surface-hover',
                )}
              >
                {columns.map((column) => (
                  <td key={column.key} className={cellClass(column)}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
