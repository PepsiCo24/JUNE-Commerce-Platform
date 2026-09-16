import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { SecurityForm } from '@/features/auth/security-form';

export const metadata: Metadata = { title: pageTitle('安全') };

export default function SecurityPage(): React.JSX.Element {
  return <SecurityForm />;
}
