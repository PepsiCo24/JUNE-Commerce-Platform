import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { AuditScreen } from '@/features/admin/screens/audit-screen';

export const metadata: Metadata = { title: pageTitle('审计') };

export default function AdminAuditPage(): React.JSX.Element {
  return <AuditScreen />;
}
