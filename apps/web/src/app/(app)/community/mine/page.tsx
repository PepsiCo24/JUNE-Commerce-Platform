import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { CommunityFeedFrame } from '@/features/community/layout/community-feed-frame';
import { MineList } from '@/features/community/posts/mine-list';

export const metadata: Metadata = { title: pageTitle('我的内容') };

export default function CommunityMinePage(): React.JSX.Element {
  return (
    <CommunityFeedFrame>
      <PageHeader
        title="我的内容"
        description="管理已发布、已隐藏和草稿。删除前会再次确认。"
        breadcrumbs={[
          { label: '社区', href: '/community' },
          { label: '我的内容' },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" asChild>
              <Link href="/community/drafts">草稿</Link>
            </Button>
            <Button asChild>
              <Link href="/community/posts/new">发布</Link>
            </Button>
          </div>
        }
      />
      <div className="mt-6">
        <MineList />
      </div>
    </CommunityFeedFrame>
  );
}
