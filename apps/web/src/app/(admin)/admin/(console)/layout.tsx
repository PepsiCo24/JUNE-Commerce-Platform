import { AdminAuthGuard } from '@/features/admin/components/admin-auth-guard';
import { AdminShell } from '@/features/admin/components/admin-shell';

export default function AdminConsoleLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <AdminAuthGuard>
      <AdminShell>{children}</AdminShell>
    </AdminAuthGuard>
  );
}
