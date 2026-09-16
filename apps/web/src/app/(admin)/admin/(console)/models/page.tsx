import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ModelsScreen } from '@/features/admin/screens/models-screen';

export const metadata: Metadata = { title: pageTitle('模型') };

export default function AdminModelsPage(): React.JSX.Element {
  return <ModelsScreen />;
}
