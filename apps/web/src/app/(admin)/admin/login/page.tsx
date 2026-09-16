import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AmbientBackdrop } from '@/components/layout/ambient-backdrop';
import { AdminLoginForm } from '@/features/admin/components/admin-login-form';

export const metadata: Metadata = { title: pageTitle('管理站登录') };

export default function AdminLoginPage(): React.JSX.Element {
  return (
    <div data-theme="dark" className="relative flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <AmbientBackdrop variant="auth" />
      <main id="main" className="relative w-full max-w-md">
        <Suspense>
          <AdminLoginForm />
        </Suspense>
      </main>
    </div>
  );
}
