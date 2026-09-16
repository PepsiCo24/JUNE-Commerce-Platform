import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ShareConfigScreen } from '@/features/admin/screens/share-config-screen';

export const metadata: Metadata = { title: pageTitle('分享配置') };

export default function AdminSharePage(): React.JSX.Element {
  return <ShareConfigScreen />;
}
