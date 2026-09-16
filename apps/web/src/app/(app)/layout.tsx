import type { AuthStateResponse } from '@june/shared';
import { redirect } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { serverGetOptional } from '@/lib/api/server';

export default async function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const state = await serverGetOptional<AuthStateResponse>('/auth/me');
  if (!state?.user) redirect('/login');

  return <AppShell user={state.user}>{children}</AppShell>;
}
