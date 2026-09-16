import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { BookmarksList } from '@/features/community/posts/bookmarks-list';

export const metadata: Metadata = { title: pageTitle('我的收藏') };

export default function CommunityBookmarksPage(): React.JSX.Element {
  return (
    <div className="bg-community-feed min-h-full w-full px-4 py-6 sm:py-8">
      <BookmarksList />
    </div>
  );
}
