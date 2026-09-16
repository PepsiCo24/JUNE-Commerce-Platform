import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { AdminsScreen } from '@/features/admin/screens/admins-screen';

export const metadata: Metadata = { title: pageTitle('管理员账号') };

export default function AdminAdminsPage(): React.JSX.Element {
  return <AdminsScreen />;
}
