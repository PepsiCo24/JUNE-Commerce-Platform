import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoadingState } from '@/components/feedback/states';
import { ImageStudio } from '@/features/workbench/components/image-studio';

export const metadata: Metadata = { title: pageTitle('生图') };

export default function WorkbenchImagePage(): React.JSX.Element {
  return (
    <Suspense fallback={<LoadingState message="加载生图工作台" />}>
      <ImageStudio />
    </Suspense>
  );
}
