import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ShopListPage } from '@/features/workbench/components/shop-list';

export const metadata: Metadata = { title: pageTitle('店铺') };

export default function WorkbenchShopsPage(): React.JSX.Element {
  return <ShopListPage />;
}
