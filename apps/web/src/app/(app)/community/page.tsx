import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { CommunityFeedFrame } from '@/features/community/layout/community-feed-frame';
import { PostHall } from '@/features/community/posts/post-hall';
import { PostGridSkeleton } from '@/features/community/posts/post-card-skeleton';

export const metadata: Metadata = { title: pageTitle('社区') };

export default function CommunityPage(): React.JSX.Element {
  return (
    <CommunityFeedFrame>
      <Suspense fallback={<PostGridSkeleton />}>
        <PostHall />
      </Suspense>
    </CommunityFeedFrame>
  );
}
