'use client';

import { FileClock, PenLine } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';

import { useCommunityListSync } from '../hooks/use-community-sse';
import { useMyPostList } from '../hooks/use-post-list';
import { MyPostActions } from './my-post-actions';
import { PostCard } from './post-card';
import { PostGridSkeleton } from './post-card-skeleton';

export function DraftsList(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const list = useMyPostList({ status: 'DRAFT', page });
  useCommunityListSync();

  const setPage = useCallback(
    (next: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next <= 1) params.delete('page');
      else params.set('page', String(next));
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [pathname, router, searchParams],
  );

  if (list.isLoading) return <PostGridSkeleton />;

  if (list.isError) {
    return <ErrorState error={list.error} onRetry={list.refetch} title="草稿列表加载失败" />;
  }

  if (list.items.length === 0) {
    return (
      <EmptyState
        icon={<FileClock size={28} />}
        title="没有草稿"
        description="开始写作后,未发布的内容会自动保存在这里。"
        action={
          <Button asChild iconLeft={<PenLine size={16} />}>
            <Link href="/community/posts/new">写一篇</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:gap-4">
        {list.items.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            showStatus
            showShare={false}
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
    </div>
  );
}
