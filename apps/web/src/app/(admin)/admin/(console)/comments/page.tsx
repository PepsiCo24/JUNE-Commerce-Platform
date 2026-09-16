import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { CommentsScreen } from '@/features/admin/screens/comments-screen';

export const metadata: Metadata = { title: pageTitle('评论') };

export default function AdminCommentsPage(): React.JSX.Element {
  return <CommentsScreen />;
}
