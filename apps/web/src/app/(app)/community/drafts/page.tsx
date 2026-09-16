import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { DraftsList } from '@/features/community/posts/drafts-list';

export const metadata: Metadata = { title: pageTitle('草稿') };

export default function CommunityDraftsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 py-8 sm:px-6">
      <PageHeader
        title="草稿"
        description="未发布的内容。可以继续编辑、发布或删除。"
        breadcrumbs={[
          { label: '社区', href: '/community' },
          { label: '草稿' },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" asChild>
              <Link href="/community/mine">我的内容</Link>
            </Button>
            <Button asChild>
              <Link href="/community/posts/new">发布</Link>
            </Button>
          </div>
        }
      />
      <div className="mt-6">
        <DraftsList />
      </div>
    </div>
  );
}
