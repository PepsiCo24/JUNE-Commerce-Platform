import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicProfileView } from '@/features/community/users/public-profile-view';
import { serverGet } from '@/lib/api/server';
import type { PublicUserProfile } from '@june/shared';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  try {
    const profile = await serverGet<PublicUserProfile>(`/community/users/${id}`);
    return { title: pageTitle(profile.displayName) };
  } catch {
    return { title: pageTitle('用户') };
  }
}

export default async function PublicUserProfilePage({ params }: PageProps): Promise<React.JSX.Element> {
  const { id } = await params;
  try {
    const profile = await serverGet<PublicUserProfile>(`/community/users/${id}`);
    return (
      <div className="min-h-dvh bg-community-feed">
        <PublicProfileView profile={profile} />
      </div>
    );
  } catch {
    notFound();
  }
}
