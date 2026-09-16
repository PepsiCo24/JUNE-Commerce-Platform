import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ShopForm } from '@/features/workbench/components/shop-form';

export const metadata: Metadata = { title: pageTitle('新建店铺') };

export default function WorkbenchNewShopPage(): React.JSX.Element {
  return <ShopForm />;
}
