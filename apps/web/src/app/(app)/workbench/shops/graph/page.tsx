import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ShopGraphPage } from '@/features/workbench/components/shop-graph';

export const metadata: Metadata = { title: pageTitle('店铺关系图') };

export default function WorkbenchShopGraphPage(): React.JSX.Element {
  return <ShopGraphPage />;
}
