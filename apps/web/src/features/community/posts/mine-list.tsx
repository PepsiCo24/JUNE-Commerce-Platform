'use client';

import type { MyPostStatus } from '@/features/community/api';
import { FileText, PenLine } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { Tabs } from '@/components/ui/tabs';

import { useCommunityListSync } from '../hooks/use-community-sse';
import { useMyPostList } from '../hooks/use-post-list';
import { MyPostActions } from './my-post-actions';
import { PostCard } from './post-card';
import { PostGridSkeleton } from './post-card-skeleton';

const STATUS_TABS: Array<{ value: MyPostStatus; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'PUBLISHED', label: '已发布' },
  { value: 'HIDDEN', label: '已隐藏' },
  { value: 'DRAFT', label: '草稿' },
];

export function MineList(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const [status, setStatus] = useState<MyPostStatus>('ALL');
  const params = useMemo(() => ({ status, page }), [status, page]);
  const list = useMyPostList(params);
  useCommunityListSync();

  const setPage = useCallback(
    (next: number) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      if (next <= 1) nextParams.delete('page');
      else nextParams.set('page', String(next));
      const query = nextParams.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [pathname, router, searchParams],
  );

  const onStatusChange = useCallback(
    (value: string) => {
      setStatus(value as MyPostStatus);
      setPage(1);
    },
    [setPage],
  );

  return (
    <div className="flex flex-col gap-6">
      <Tabs value={status} onChange={onStatusChange} items={STATUS_TABS} />

      {list.isLoading ? <PostGridSkeleton /> : null}

      {!list.isLoading && list.isError ? (
        <ErrorState error={list.error} onRetry={list.refetch} title="我的内容加载失败" />
      ) : null}

      {!list.isLoading && !list.isError && list.items.length === 0 ? (
        <EmptyState
          icon={<FileText size={28} />}
          title={status === 'ALL' ? '还没有自己的内容' : '这一栏是空的'}
          description={
            status === 'DRAFT' ? '没有草稿。可以从发布页开始写。' : '发布第一篇,就会出现在这里。'
          }
          action={
            <Button asChild iconLeft={<PenLine size={16} />}>
              <Link href="/community/posts/new">去发布</Link>
            </Button>
          }
        />
      ) : null}

      {!list.isLoading && !list.isError && list.items.length > 0 ? (
        <>
          <div className="flex flex-col gap-3 sm:gap-4">
            {list.items.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                showStatus
                showShare={post.status === 'PUBLISHED'}
                actions={<MyPostActions post={post} />}
              />
            ))}
          </div>
          <Pagination
            page={list.page}
            pageSize={list.pageSize}
            total={list.total}
            onPageChange={setPage}
          />
        </>
      ) : null}
    </div>
  );
}
