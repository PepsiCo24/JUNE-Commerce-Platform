import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { DraftEditorLoader } from '@/features/community/editor/editor-loaders';

type PageProps = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: pageTitle('编辑草稿') };

export default async function CommunityDraftEditPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { id } = await params;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <PageHeader
        title="继续编辑草稿"
        description="内容会自动保存。确认无误后再发布。"
        breadcrumbs={[
          { label: '社区', href: '/community' },
          { label: '草稿', href: '/community/drafts' },
          { label: '编辑' },
        ]}
        actions={
          <Button variant="ghost" asChild>
            <Link href="/community/drafts">返回草稿</Link>
          </Button>
        }
      />
      <div className="mt-6">
        <DraftEditorLoader draftId={id} />
      </div>
    </div>
  );
}
