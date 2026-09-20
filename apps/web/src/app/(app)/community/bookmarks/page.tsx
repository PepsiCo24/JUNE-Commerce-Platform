import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { CommunityFeedFrame } from '@/features/community/layout/community-feed-frame';
import { BookmarksList } from '@/features/community/posts/bookmarks-list';

export const metadata: Metadata = { title: pageTitle('我的收藏') };

export default function CommunityBookmarksPage(): React.JSX.Element {
  return (
    <CommunityFeedFrame>
      <BookmarksList />
    </CommunityFeedFrame>
  );
}
