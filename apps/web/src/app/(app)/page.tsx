import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { HomeGate } from '@/features/auth/home-gate';

export const metadata: Metadata = { title: pageTitle('首页') };

export default function HomePage(): React.JSX.Element {
  return <HomeGate />;
}
