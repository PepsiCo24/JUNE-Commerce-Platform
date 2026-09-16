import type { AuthStateResponse } from '@june/shared';

import { AppShell } from '@/components/layout/app-shell';
import { GuestShell } from '@/components/layout/guest-shell';
import { serverGetOptional } from '@/lib/api/server';

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const state = await serverGetOptional<AuthStateResponse>('/auth/me');
  if (state?.user) return <AppShell user={state.user}>{children}</AppShell>;
  return <GuestShell>{children}</GuestShell>;
}
