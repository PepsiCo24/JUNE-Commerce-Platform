'use client';

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatBytes, formatChartDate, formatChartDateFull, formatInteger } from '@/features/admin/lib/format';

export interface TrendSeries {
  key: string;
  name: string;
  colorClass: 'accent' | 'purple' | 'danger' | 'muted';
}

const STROKE: Record<TrendSeries['colorClass'], string> = {
  accent: 'var(--accent)',
  purple: 'var(--purple-accent, var(--accent))',
  danger: 'var(--state-danger-fg)',
  muted: 'var(--fg-muted)',
};

export function TrendChart({
  data,
  series,
  kind = 'count',
  definition,
}: {
  data: Array<Record<string, string | number>>;
  series: TrendSeries[];
  kind?: 'count' | 'rate' | 'bytes';
  definition?: string;
}): React.JSX.Element {
  const Chart = series.length > 1 ? LineChart : AreaChart;
  const formatY = useMemo(() => {
    if (kind === 'bytes') return (v: number) => formatBytes(v);
    if (kind === 'rate') return (v: number) => `${v.toFixed(0)}%`;
    return (v: number) => formatInteger(v);
  }, [kind]);

  return (
    <div className="rounded-lg border border-border-default bg-surface p-4">
      {definition ? <p className="mb-3 text-xs text-fg-muted">{definition}</p> : null}
      <div className="h-64 w-full text-accent">
        <ResponsiveContainer width="100%" height="100%">
          <Chart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickFormatter={formatChartDate}
              tick={{ fontSize: 11, fill: 'var(--fg-muted)' }}
              axisLine={{ stroke: 'var(--border)' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={formatY}
              tick={{ fontSize: 11, fill: 'var(--fg-muted)' }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              labelFormatter={(label) => formatChartDateFull(String(label))}
              formatter={(value, name) => [
                kind === 'bytes'
                  ? formatBytes(Number(value))
                  : kind === 'rate'
                    ? `${Number(value).toFixed(1)}%`
                    : formatInteger(Number(value)),
                String(name),
              ]}
              contentStyle={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
            {series.map((item) =>
              series.length > 1 ? (
                <Line
                  key={item.key}
                  type="monotone"
                  dataKey={item.key}
                  name={item.name}
                  stroke={STROKE[item.colorClass]}
                  strokeWidth={2}
                  dot={false}
                />
              ) : (
                <Area
                  key={item.key}
                  type="monotone"
                  dataKey={item.key}
                  name={item.name}
                  stroke={STROKE[item.colorClass]}
                  fill={STROKE[item.colorClass]}
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              ),
            )}
          </Chart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
