import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { AvatarSettings } from '@/features/settings/avatar-settings';

export const metadata: Metadata = { title: pageTitle('头像设置') };

export default function AvatarPage(): React.JSX.Element {
  return <AvatarSettings />;
}
