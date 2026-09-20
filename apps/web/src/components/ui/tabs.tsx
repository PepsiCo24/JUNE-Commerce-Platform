'use client';

import { useRef } from 'react';

import { cn } from '@/lib/utils';

/**
 * 标签切换条。
 *
 * 这里手写 role="tablist" 而不是用 @radix-ui/react-tabs:契约里的 Tabs 只负责切换,
 * 不渲染面板内容(内容由各页面自己组织),而 Radix 的 Trigger 一定会输出
 * 指向面板的 aria-controls,指向不存在的元素反而是无障碍缺陷。
 * 键盘行为按 WAI-ARIA Tabs 模式手动实现:左右方向键移动、Home/End 跳首尾。
 */
export function Tabs({
  value,
  onChange,
  items,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  items: Array<{ value: string; label: React.ReactNode; count?: number; disabled?: boolean }>;
  className?: string;
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);

  const moveFocus = (from: number, direction: 1 | -1 | 'first' | 'last'): void => {
    const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
    if (enabled.length === 0) return;

    let target: { item: (typeof items)[number]; index: number } | undefined;
    if (direction === 'first') target = enabled[0];
    else if (direction === 'last') target = enabled[enabled.length - 1];
    else {
      const currentPosition = enabled.findIndex(({ index }) => index === from);
      const nextPosition = (currentPosition + direction + enabled.length) % enabled.length;
      target = enabled[nextPosition];
    }
    if (!target) return;

    onChange(target.item.value);
    const nodes = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    nodes?.[target.index]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      className={cn(
        'flex items-center gap-1 overflow-x-auto border-b border-border-default',
        // 窄屏仍可横滑,但不显示滚动条(深色主题下易看成多余竖条)
        '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={item.disabled}
            // 只有选中项进 Tab 键序列,符合 tablist 的漫游焦点约定
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                moveFocus(index, 1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                moveFocus(index, -1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                moveFocus(index, 'first');
              } else if (event.key === 'End') {
                event.preventDefault();
                moveFocus(index, 'last');
              }
            }}
            className={cn(
              '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150',
              'disabled:pointer-events-none disabled:opacity-50',
              selected
                ? 'border-accent text-accent'
                : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
            )}
          >
            <span className="truncate">{item.label}</span>
            {typeof item.count === 'number' && (
              <span
                className={cn(
                  'tabular rounded-full px-1.5 text-[11px] leading-5',
                  selected ? 'bg-accent-surface text-accent' : 'bg-surface text-fg-subtle',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
