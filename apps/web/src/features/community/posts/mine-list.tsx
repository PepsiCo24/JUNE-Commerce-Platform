'use client';

import type { MyPostStatus } from '@/features/community/api';
import { FileText, PenLine } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { LoadMore } from '@/components/ui/pagination';
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
  const [status, setStatus] = useState<MyPostStatus>('ALL');
  const params = useMemo(() => ({ status }), [status]);
  const list = useMyPostList(params);
  useCommunityListSync();

  return (
    <div className="flex flex-col gap-6">
      <Tabs
        value={status}
        onChange={(value) => setStatus(value as MyPostStatus)}
        items={STATUS_TABS}
      />

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
          <LoadMore hasMore={list.hasMore} loading={list.isFetchingNextPage} onLoadMore={list.loadMore} />
        </>
      ) : null}
    </div>
  );
}
