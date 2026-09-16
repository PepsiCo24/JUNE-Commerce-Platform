import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { StorageScreen } from '@/features/admin/screens/storage-screen';

export const metadata: Metadata = { title: pageTitle('存储') };

export default function AdminStoragePage(): React.JSX.Element {
  return <StorageScreen />;
}
