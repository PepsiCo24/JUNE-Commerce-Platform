import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { CredentialsOverviewPage } from '@/features/workbench/components/credentials-panel';

export const metadata: Metadata = { title: pageTitle('凭据') };

export default function WorkbenchCredentialsPage(): React.JSX.Element {
  return <CredentialsOverviewPage />;
}
