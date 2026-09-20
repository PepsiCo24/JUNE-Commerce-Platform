import type { Metadata } from 'next';

import { ShopProductListPage } from '@/features/workbench/components/shop-product-list';

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return { title: `店铺商品 · ${id.slice(0, 8)}` };
}

export default async function ShopProductsRoute({ params }: PageProps): Promise<React.JSX.Element> {
  const { id } = await params;
  return <ShopProductListPage shopId={id} />;
}
