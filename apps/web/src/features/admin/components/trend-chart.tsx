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

import {
  formatBytes,
  formatChartDate,
  formatChartDateFull,
  formatInteger,
} from '@/features/admin/lib/format';

export interface TrendSeries {
  key: string;
  name: string;
  colorClass: 'accent' | 'purple' | 'danger' | 'muted';
}

const STROKE: Record<TrendSeries['colorClass'], string> = {
  accent: 'var(--accent)',
  purple: 'var(--purple-accent, var(--accent))',
  danger: 'var(--danger-fg)',
  muted: 'var(--text-muted)',
};

export function TrendChart({
  data,
  series,
  kind = 'count',
  title,
  description,
}: {
  data: Array<Record<string, string | number>>;
  series: TrendSeries[];
  kind?: 'count' | 'rate' | 'bytes';
  title?: string;
  description?: string;
}): React.JSX.Element {
  const Chart = series.length > 1 ? LineChart : AreaChart;
  const formatY = useMemo(() => {
    if (kind === 'bytes') return (v: number) => formatBytes(v);
    if (kind === 'rate') return (v: number) => `${v.toFixed(0)}%`;
    return (v: number) => formatInteger(v);
  }, [kind]);

  return (
    <div className="rounded-lg border border-border-default bg-surface p-4">
      {title ? <h2 className="text-sm font-semibold text-fg">{title}</h2> : null}
      {description ? <p className="mt-1 text-xs text-fg-muted">{description}</p> : null}
      <div className="mt-5 h-64 w-full min-w-0 text-accent">
        {data.some((point) => series.some((item) => Number(point[item.key]) > 0)) ? (
          <ResponsiveContainer width="100%" height="100%">
            <Chart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={formatChartDate}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={formatY}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                axisLine={false}
                tickLine={false}
                domain={kind === 'rate' ? [0, 100] : [0, 'auto']}
                allowDecimals={kind !== 'count'}
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
        ) : (
          <p className="flex h-full items-center justify-center text-sm text-fg-subtle">所选时段暂无记录</p>
        )}
      </div>
    </div>
  );
}
