import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { DashboardScreen } from '@/features/admin/screens/dashboard-screen';

export const metadata: Metadata = { title: pageTitle('仪表盘') };

export default function AdminDashboardPage(): React.JSX.Element {
  return <DashboardScreen />;
}
