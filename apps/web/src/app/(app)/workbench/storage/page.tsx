import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { StorageUsagePage } from '@/features/workbench/components/storage-usage';

export const metadata: Metadata = { title: pageTitle('存储') };

export default function WorkbenchStoragePage(): React.JSX.Element {
  return <StorageUsagePage />;
}
