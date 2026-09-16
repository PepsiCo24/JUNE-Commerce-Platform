import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoadingState } from '@/components/feedback/states';
import { CopyStudio } from '@/features/workbench/components/copy-studio';

export const metadata: Metadata = { title: pageTitle('文案') };

export default function WorkbenchCopyPage(): React.JSX.Element {
  return (
    <Suspense fallback={<LoadingState message="加载文案工作台" />}>
      <CopyStudio />
    </Suspense>
  );
}
