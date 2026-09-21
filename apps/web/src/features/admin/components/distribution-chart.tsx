'use client';

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { formatBytes, formatInteger, formatRate } from '@/features/admin/lib/format';

export interface DistributionItem {
  key: string;
  label: string;
  value: number;
}

const COLORS = [
  'var(--accent)',
  'var(--purple-accent, var(--accent))',
  'var(--danger-fg)',
  'var(--text-muted)',
  'var(--warning-fg)',
  'var(--success-fg)',
];

export function DistributionChart({
  title,
  description,
  items,
  kind = 'count',
  emptyText = '暂无数据',
}: {
  title: string;
  description?: string;
  items: DistributionItem[];
  kind?: 'count' | 'rate' | 'bytes';
  emptyText?: string;
}): React.JSX.Element {
  const data = items.filter(
    (item) => Number.isFinite(item.value) && (kind === 'rate' ? item.value >= 0 : item.value > 0),
  );
  const formatValue = (value: number) => {
    if (kind === 'bytes') return formatBytes(value);
    if (kind === 'rate') return formatRate(value);
    return formatInteger(value);
  };

  return (
    <div className="rounded-lg border border-border-default bg-surface p-4">
      <div className="mb-3">
        <h2 className="text-sm font-medium text-fg">{title}</h2>
        {description ? <p className="mt-1 text-xs text-fg-muted">{description}</p> : null}
      </div>
      {data.length === 0 ? (
        <p className="flex h-48 items-center justify-center text-sm text-fg-subtle">{emptyText}</p>
      ) : (
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
              <XAxis
                type="number"
                domain={kind === 'rate' ? [0, 100] : [0, 'auto']}
                allowDecimals={kind !== 'count'}
                tickFormatter={(value) => formatValue(Number(value))}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={88}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                formatter={(value) => [formatValue(Number(value)), '']}
                contentStyle={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: 'var(--text)' }}
              />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={28}>
                {data.map((item, index) => (
                  <Cell key={item.key} fill={COLORS[index % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
