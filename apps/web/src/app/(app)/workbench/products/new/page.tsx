import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ProductFormPage } from '@/features/workbench/components/product-form';

export const metadata: Metadata = { title: pageTitle('新建商品') };

export default function WorkbenchNewProductPage(): React.JSX.Element {
  return <ProductFormPage />;
}
