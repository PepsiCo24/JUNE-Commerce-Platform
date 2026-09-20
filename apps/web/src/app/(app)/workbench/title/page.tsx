import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { TitleStudio } from '@/features/workbench/components/title-studio';

export const metadata: Metadata = { title: pageTitle('标题生成') };

export default function WorkbenchTitlePage(): React.JSX.Element {
  return <TitleStudio />;
}
