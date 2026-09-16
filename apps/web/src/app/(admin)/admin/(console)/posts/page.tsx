import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { PostsScreen } from '@/features/admin/screens/posts-screen';

export const metadata: Metadata = { title: pageTitle('帖子') };

export default function AdminPostsPage(): React.JSX.Element {
  return <PostsScreen />;
}
