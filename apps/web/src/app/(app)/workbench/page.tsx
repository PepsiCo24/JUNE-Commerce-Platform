import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { OverviewDashboard } from '@/features/workbench/components/overview-dashboard';

export const metadata: Metadata = { title: pageTitle('工作台') };

export default function WorkbenchIndexPage(): React.JSX.Element {
  return <OverviewDashboard />;
}
