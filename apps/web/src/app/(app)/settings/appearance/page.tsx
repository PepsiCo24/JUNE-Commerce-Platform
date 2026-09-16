import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { AppearanceSettings } from '@/features/settings/appearance-settings';

export const metadata: Metadata = { title: pageTitle('外观设置') };

export default function AppearancePage(): React.JSX.Element {
  return <AppearanceSettings />;
}
