import { AlertCircle, CheckCircle2, Info } from 'lucide-react';

import { cn } from '@/lib/utils';

export function InlineAlert({
  tone = 'danger',
  children,
  className,
}: {
  tone?: 'danger' | 'success' | 'warning' | 'info';
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertCircle;
  const role = tone === 'danger' || tone === 'warning' ? 'alert' : 'status';

  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
        tone === 'danger' && 'border-state-danger-border bg-state-danger-bg text-state-danger-fg',
        tone === 'success' && 'border-state-success-border bg-state-success-bg text-state-success-fg',
        tone === 'warning' && 'border-state-warning-border bg-state-warning-bg text-state-warning-fg',
        tone === 'info' && 'border-state-info-border bg-state-info-bg text-state-info-fg',
        className,
      )}
    >
      <Icon size={16} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}
