'use client';

import {
  POST_CATEGORIES,
  POST_CATEGORY_LABELS,
  type PostCategory,
} from '@june/shared';
import { Bookmark, FileText, LayoutList, PenLine, Shield, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const PERSONAL_NAV = [
  {
    href: '/community',
    label: '全部帖子',
    icon: LayoutList,
    match: (path: string) => path === '/community',
  },
  {
    href: '/community/mine',
    label: '我的帖子',
    icon: UserRound,
    match: (path: string) => path.startsWith('/community/mine'),
  },
  {
    href: '/community/bookmarks',
    label: '我的收藏',
    icon: Bookmark,
    match: (path: string) => path.startsWith('/community/bookmarks'),
  },
  {
    href: '/community/drafts',
    label: '草稿箱',
    icon: FileText,
    match: (path: string) => path.startsWith('/community/drafts'),
  },
] as const;

const GUIDELINES = [
  '友善讨论,拒绝人身攻击',
  '分享真实经验,少灌水',
  '违规内容可联系管理员',
] as const;

/**
 * 左侧栏:个人入口 + 分类 + 社区公约。
 * 高度对齐可视区域(顶栏以下),中间分类区 flex 吃满,不出现内部滚动条。
 */
export function CommunityRail(): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeCategory = searchParams.get('category');

  return (
    <aside className="flex h-[calc(100dvh-4.5rem)] flex-col gap-4 overflow-hidden">
      <div className="shrink-0 overflow-hidden rounded-2xl border border-border-default bg-bg-elevated/90 shadow-sm backdrop-blur-sm">
        <div className="border-b border-border-default px-3.5 py-3">
          <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">导航</p>
        </div>
        <nav aria-label="个人内容" className="flex flex-col p-2">
          {PERSONAL_NAV.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors',
                  active
                    ? 'bg-accent-surface font-medium text-accent'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                )}
              >
                <Icon size={15} aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border-default p-2.5">
          <Button asChild size="sm" fullWidth iconLeft={<PenLine size={14} />}>
            <Link href="/community/posts/new">发布帖子</Link>
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border-default bg-bg-elevated/90 shadow-sm backdrop-blur-sm">
        <div className="shrink-0 border-b border-border-default px-3.5 py-3">
          <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">分类</p>
        </div>
        <nav aria-label="帖子分类" className="flex flex-1 flex-col p-2">
          <CategoryLink href="/community" label="全部" active={!activeCategory} />
          {POST_CATEGORIES.map((value) => (
            <CategoryLink
              key={value}
              href={`/community?category=${value}`}
              label={POST_CATEGORY_LABELS[value as PostCategory]}
              active={activeCategory === value}
            />
          ))}
        </nav>
      </div>

      <div className="shrink-0 overflow-hidden rounded-2xl border border-border-default bg-bg-elevated/90 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2 border-b border-border-default px-3.5 py-3">
          <Shield size={14} className="text-accent" aria-hidden />
          <p className="text-sm font-medium text-fg">社区公约</p>
        </div>
        <ul className="flex flex-col gap-2 px-3.5 py-3 text-xs leading-relaxed text-fg-muted">
          {GUIDELINES.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent/70" aria-hidden />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function CategoryLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-lg px-2.5 py-1.5 text-sm transition-colors',
        active
          ? 'bg-accent-surface font-medium text-accent'
          : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
      )}
    >
      {label}
    </Link>
  );
}
