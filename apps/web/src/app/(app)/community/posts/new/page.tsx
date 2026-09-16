import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { PostEditor } from '@/features/community/editor/post-editor';

export const metadata: Metadata = { title: pageTitle('发布') };

export default function CommunityNewPostPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <PageHeader
        title="发布"
        description="标题、正文与图片会自动保存为草稿，确认后再发布。"
        breadcrumbs={[
          { label: '社区', href: '/community' },
          { label: '发布' },
        ]}
        actions={
          <Button variant="ghost" asChild>
            <Link href="/community/drafts">我的草稿</Link>
          </Button>
        }
      />
      <div className="mt-6">
        <PostEditor mode="create" initialDraftId={null} />
      </div>
    </div>
  );
}
