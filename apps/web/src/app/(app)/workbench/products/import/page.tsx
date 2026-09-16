import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ProductImportPage } from '@/features/workbench/components/product-import';

export const metadata: Metadata = { title: pageTitle('导入商品') };

export default function WorkbenchProductImportRoute(): React.JSX.Element {
  return <ProductImportPage />;
}
