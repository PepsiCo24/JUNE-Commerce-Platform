'use client';

import { useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';

interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

function extractHeadings(html: string): TocItem[] {
  if (typeof window === 'undefined') return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items: TocItem[] = [];
  doc.querySelectorAll('h2, h3').forEach((node, index) => {
    const level = node.tagName === 'H2' ? 2 : 3;
    const text = node.textContent?.trim() ?? '';
    if (!text) return;
    const id = `section-${index}-${text.slice(0, 20).replace(/\s+/g, '-')}`;
    items.push({ id, text, level });
  });
  return items;
}

/** 长文目录:桌面侧栏,小屏折叠 */
export function PostToc({
  contentHtml,
  variant = 'both',
}: {
  contentHtml: string;
  variant?: 'both' | 'sidebar' | 'mobile';
}): React.JSX.Element | null {
  const items = useMemo(() => extractHeadings(contentHtml), [contentHtml]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (items.length < 3) return;
    const headings = document.querySelectorAll('.june-prose h2, .june-prose h3');
    headings.forEach((node, index) => {
      const item = items[index];
      if (item) node.id = item.id;
    });

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    headings.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [items, contentHtml]);

  if (items.length < 3) return null;

  const list = (
    <ul className="flex flex-col gap-1 text-sm">
      {items.map((item) => (
        <li key={item.id} className={cn(item.level === 3 && 'pl-3')}>
          <a
            href={`#${item.id}`}
            className={cn(
              'block truncate rounded-sm px-2 py-1 text-fg-muted hover:bg-surface-hover hover:text-fg',
              active === item.id && 'bg-accent-surface text-accent',
            )}
          >
            {item.text}
          </a>
        </li>
      ))}
    </ul>
  );

  const showSidebar = variant === 'both' || variant === 'sidebar';
  const showMobile = variant === 'both' || variant === 'mobile';

  return (
    <>
      {showSidebar ? (
        <aside className="hidden w-48 shrink-0 xl:block">
          <nav aria-label="文章目录" className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-lg border border-border-default bg-surface p-3">
            <p className="mb-2 text-xs font-medium text-fg-subtle">目录</p>
            {list}
          </nav>
        </aside>
      ) : null}
      {showMobile ? (
        <div className="xl:hidden">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mb-4 w-full rounded-md border border-border-default bg-surface px-3 py-2 text-left text-sm text-fg"
          >
            {open ? '收起目录' : `目录 (${items.length})`}
          </button>
          {open ? <nav className="mb-4 rounded-md border border-border-default bg-surface p-3">{list}</nav> : null}
        </div>
      ) : null}
    </>
  );
}
