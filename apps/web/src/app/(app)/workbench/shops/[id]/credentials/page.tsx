import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ShopCredentialsPage } from '@/features/workbench/components/credentials-panel';

type PageProps = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: pageTitle('店铺凭据') };

export default async function WorkbenchShopCredentialsRoute({ params }: PageProps): Promise<React.JSX.Element> {
  const { id } = await params;
  return <ShopCredentialsPage shopId={id} />;
}
