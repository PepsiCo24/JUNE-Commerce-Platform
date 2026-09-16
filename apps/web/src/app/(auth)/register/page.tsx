import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AmbientBackdrop } from '@/components/layout/ambient-backdrop';
import { RegisterForm } from '@/features/auth/register-form';

export const metadata: Metadata = { title: pageTitle('注册') };

export default function RegisterPage(): React.JSX.Element {
  return (
    <div data-theme="dark" className="relative flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <AmbientBackdrop variant="auth" />
      <main id="main" className="relative w-full max-w-md">
        <Suspense>
          <RegisterForm />
        </Suspense>
      </main>
    </div>
  );
}
