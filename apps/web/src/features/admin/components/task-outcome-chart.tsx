'use client';

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { formatInteger, formatRate } from '../lib/format';
import type { buildTaskOutcomes } from '../lib/dashboard-data';

export function TaskOutcomeChart({
  items,
}: {
  items: ReturnType<typeof buildTaskOutcomes>;
}): React.JSX.Element {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <section className="rounded-lg border border-border-default bg-surface p-5">
      <h2 className="text-sm font-semibold">任务结果分布</h2>
      <p className="mt-1 text-xs text-fg-muted">所选时段创建的任务，按当前结果展示</p>
      {total === 0 ? (
        <p className="flex h-64 items-center justify-center text-sm text-fg-subtle">所选时段暂无生成任务</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-6">
          <div className="relative h-60 w-60 shrink-0" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={items.filter((item) => item.value > 0)}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={72}
                  outerRadius={94}
                  paddingAngle={3}
                  stroke="none"
                >
                  {items
                    .filter((item) => item.value > 0)
                    .map((item) => (
                      <Cell key={item.key} fill={item.color} />
                    ))}
                </Pie>
                <Tooltip
                  formatter={(value) => [`${formatInteger(Number(value))} 个任务`, '']}
                  contentStyle={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <strong className="text-3xl tabular">{formatInteger(total)}</strong>
              <span className="mt-1 text-xs text-fg-muted">生成任务</span>
            </div>
          </div>
          <ul className="min-w-44 flex-1 space-y-4 py-4">
            {items.map((item) => (
              <li key={item.key} className="flex items-center gap-2 text-sm">
                <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />
                <span className="text-fg-muted">{item.label}</span>
                <span className="ml-auto font-medium tabular">{formatInteger(item.value)}</span>
                <span className="w-14 text-right text-xs tabular text-fg-subtle">
                  {formatRate((item.value / total) * 100)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
