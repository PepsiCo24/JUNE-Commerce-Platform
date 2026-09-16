import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ProductListPage } from '@/features/workbench/components/product-list';

export const metadata: Metadata = { title: pageTitle('商品') };

export default function WorkbenchProductsPage(): React.JSX.Element {
  return <ProductListPage />;
}
