import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ProfileForm } from '@/features/auth/profile-form';

export const metadata: Metadata = { title: pageTitle('个人资料') };

export default function ProfilePage(): React.JSX.Element {
  return <ProfileForm />;
}
