import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { UsersScreen } from '@/features/admin/screens/users-screen';

export const metadata: Metadata = { title: pageTitle('用户') };

export default function AdminUsersPage(): React.JSX.Element {
  return <UsersScreen />;
}
