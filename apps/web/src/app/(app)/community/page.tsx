import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { PostHall } from '@/features/community/posts/post-hall';
import { PostGridSkeleton } from '@/features/community/posts/post-card-skeleton';

export const metadata: Metadata = { title: pageTitle('社区') };

export default function CommunityPage(): React.JSX.Element {
  return (
    <div className="bg-community-feed min-h-full w-full px-4 py-6 sm:py-8">
      <Suspense
        fallback={
          <div className="mx-auto w-full max-w-[900px]">
            <PostGridSkeleton />
          </div>
        }
      >
        <PostHall />
      </Suspense>
    </div>
  );
}
