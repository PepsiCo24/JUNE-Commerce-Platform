'use client';

import { InfoHint } from '@/components/ui/tooltip';
import { formatBytes, formatInteger, formatRate } from '@/features/admin/lib/format';
import { cn } from '@/lib/utils';

export function MetricCard({
  label,
  value,
  definition,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  definition: string;
  hint?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-default bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-fg-muted">{label}</p>
        <InfoHint>{definition}</InfoHint>
      </div>
      <p className={cn('mt-2 text-2xl font-semibold tabular text-fg')}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

export function formatMetricValue(value: number | string, kind: 'count' | 'rate' | 'bytes' = 'count'): string {
  if (kind === 'bytes') return formatBytes(value);
  if (kind === 'rate') return formatRate(typeof value === 'number' ? value : Number(value));
  return formatInteger(typeof value === 'number' ? value : Number(value));
}
