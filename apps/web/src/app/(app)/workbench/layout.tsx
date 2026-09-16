import { WorkbenchNav } from '@/features/workbench/components/workbench-nav';

export default function WorkbenchLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col md:flex-row">
      <WorkbenchNav />
      <div className="min-w-0 flex-1 px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}
