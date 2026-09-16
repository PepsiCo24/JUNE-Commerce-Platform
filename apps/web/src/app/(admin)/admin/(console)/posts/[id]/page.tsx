import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { PostDetailScreen } from '@/features/admin/screens/post-detail-screen';

export const metadata: Metadata = { title: pageTitle('帖子详情') };

export default async function AdminPostDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return <PostDetailScreen postId={id} />;
}
