import type { TrendPoint } from '../api/types';

export function buildTaskOutcomes(total: number, succeeded: number, partial: number, failed: number) {
  return [
    { key: 'succeeded', label: '全部成功', value: succeeded, color: 'var(--accent)' },
    { key: 'partial', label: '部分成功', value: partial, color: 'var(--warning-fg)' },
    { key: 'failed', label: '失败', value: failed, color: 'var(--danger-fg)' },
    {
      key: 'other',
      label: '其他状态',
      value: Math.max(0, total - succeeded - partial - failed),
      color: 'var(--text-subtle)',
    },
  ];
}

export function mergeUserTrends(newUsers: TrendPoint[], activeUsers: TrendPoint[]) {
  const added = new Map(newUsers.map((point) => [point.date, point.value]));
  const active = new Map(activeUsers.map((point) => [point.date, point.value]));
  return [...new Set([...added.keys(), ...active.keys()])].sort().map((date) => ({
    date,
    newUsers: added.get(date) ?? 0,
    activeUsers: active.get(date) ?? 0,
  }));
}
