import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { PublishedEditorLoader } from '@/features/community/editor/editor-loaders';

type PageProps = { params: Promise<{ slug: string }> };

export const metadata: Metadata = { title: pageTitle('编辑帖子') };

export default async function CommunityEditPostPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { slug } = await params;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <PageHeader
        title="编辑帖子"
        description="修改会在你点击「更新」后写入已发布内容,不会自动保存。"
        breadcrumbs={[
          { label: '社区', href: '/community' },
          { label: '编辑' },
        ]}
        actions={
          <Button variant="ghost" asChild>
            <Link href="/community/mine">我的内容</Link>
          </Button>
        }
      />
      <div className="mt-6">
        <PublishedEditorLoader slug={slug} />
      </div>
    </div>
  );
}
