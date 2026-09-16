import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { SystemConfigScreen } from '@/features/admin/screens/system-config-screen';

export const metadata: Metadata = { title: pageTitle('系统配置') };

export default function AdminSystemPage(): React.JSX.Element {
  return <SystemConfigScreen />;
}
