import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ProductFormPage } from '@/features/workbench/components/product-form';

type PageProps = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: pageTitle('商品详情') };

export default async function WorkbenchProductDetailRoute({ params }: PageProps): Promise<React.JSX.Element> {
  const { id } = await params;
  return <ProductFormPage productId={id} />;
}
