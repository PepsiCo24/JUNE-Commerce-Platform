import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { ContentRulesScreen } from '@/features/admin/screens/content-rules-screen';

export const metadata: Metadata = { title: pageTitle('内容规则') };

export default function AdminContentRulesPage(): React.JSX.Element {
  return <ContentRulesScreen />;
}
