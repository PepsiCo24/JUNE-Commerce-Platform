import { pageTitle, type AuthStateResponse } from '@june/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { AmbientBackdrop } from '@/components/layout/ambient-backdrop';
import { LoginForm } from '@/features/auth/login-form';
import { serverGetOptional } from '@/lib/api/server';

export const metadata: Metadata = { title: pageTitle('登录') };

export default async function LoginPage(): Promise<React.JSX.Element> {
  const state = await serverGetOptional<AuthStateResponse>('/auth/me');
  if (state?.user) redirect('/');

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <AmbientBackdrop variant="auth" />
      <main id="main" className="relative w-full max-w-md">
        <Suspense>
          <LoginForm />
        </Suspense>
      </main>
    </div>
  );
}
