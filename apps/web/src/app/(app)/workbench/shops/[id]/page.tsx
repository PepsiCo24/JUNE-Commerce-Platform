import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ShopDetailPage } from '@/features/workbench/components/shop-detail';

type PageProps = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: pageTitle('店铺详情') };

export default async function WorkbenchShopDetailRoute({ params }: PageProps): Promise<React.JSX.Element> {
  const { id } = await params;
  return <ShopDetailPage shopId={id} />;
}
