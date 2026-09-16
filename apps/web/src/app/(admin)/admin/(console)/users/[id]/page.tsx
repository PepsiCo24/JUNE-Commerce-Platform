import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { UserDetailScreen } from '@/features/admin/screens/user-detail-screen';

export const metadata: Metadata = { title: pageTitle('用户详情') };

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return <UserDetailScreen userId={id} />;
}
