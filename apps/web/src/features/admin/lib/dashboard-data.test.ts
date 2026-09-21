import { describe, expect, it } from 'vitest';

import { buildTaskOutcomes, mergeUserTrends } from './dashboard-data';

describe('dashboard chart data', () => {
  it('keeps other task states separate from failures', () => {
    expect(buildTaskOutcomes(12, 6, 2, 1).map((item) => item.value)).toEqual([6, 2, 1, 3]);
  });

  it('does not invent completed tasks or a negative remaining count', () => {
    expect(buildTaskOutcomes(0, 0, 0, 0).every((item) => item.value === 0)).toBe(true);
    expect(buildTaskOutcomes(2, 3, 0, 0).at(-1)?.value).toBe(0);
  });

  it('aligns user series by date rather than array index', () => {
    expect(
      mergeUserTrends(
        [{ date: '2026-09-02', value: 3 }],
        [
          { date: '2026-09-01', value: 5 },
          { date: '2026-09-02', value: 7 },
        ],
      ),
    ).toEqual([
      { date: '2026-09-01', newUsers: 0, activeUsers: 5 },
      { date: '2026-09-02', newUsers: 3, activeUsers: 7 },
    ]);
  });
});
