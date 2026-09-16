'use client';

import { useParams } from 'next/navigation';

import { ShopCredentialsPage } from './credentials-panel';

export function ShopCredentialsRoute(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const shopId = typeof params.id === 'string' ? params.id : '';
  return <ShopCredentialsPage shopId={shopId} />;
}
