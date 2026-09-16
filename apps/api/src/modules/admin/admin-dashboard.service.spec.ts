import 'reflect-metadata';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { successRate } from './admin-stats.util';

/**
 * 仪表盘统计口径测试。核心断言:
 *   成功率分母 = SUCCEEDED + PARTIAL + FAILED,**不含 QUEUED / RUNNING / UNKNOWN**。
 * 用 mock 的 PrismaService,按 SQL 文本分派返回值,不连真实数据库。
 */

/** 区间内共 20 个任务:8 成功、1 部分成功、1 失败,其余 10 个是 QUEUED/RUNNING/UNKNOWN 等未终态 */
const TOTALS_ROW = {
  users_total: 100,
  users_new: 5,
  users_active: 7,
  shops_total: 12,
  shops_main: 8,
  shops_sub: 4,
  products_total: 30,
  posts_total: 9,
  posts_published: 6,
  posts_draft: 2,
  posts_hidden: 1,
  comments_total: 11,
  tasks_total: 20,
  tasks_succeeded: 8,
  tasks_partial: 1,
  tasks_failed: 1,
  storage_bytes: '123456789012',
  storage_recycled: '1024',
};

const QUERY = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-03T00:00:00.000Z',
  granularity: 'day' as const,
};

function createHarness() {
  const sqlTexts: string[] = [];

  const queryRaw = vi.fn(async (sql: { text: string }) => {
    const text = sql.text;
    sqlTexts.push(text);

    if (text.includes('users_total')) return [TOTALS_ROW];
    if (text.includes('FROM generation_tasks')) {
      return [{ bucket: '2026-09-02', total: 10, succeeded: 4, partial: 0, failed: 1 }];
    }
    if (text.includes('FROM sessions')) return [{ bucket: '2026-09-02', value: 3 }];
    if (text.includes('FROM posts')) return [{ bucket: '2026-09-03', value: 2 }];
    if (text.includes('FROM assets')) return [{ bucket: '2026-09-01', value: '2048' }];
    if (text.includes('FROM users')) return [{ bucket: '2026-09-01', value: 5 }];
    return [];
  });

  // 简易内存缓存,用于验证"命中缓存后不再重复聚合"
  const store = new Map<string, unknown>();
  const redis = {
    getJson: vi.fn(async (key: string) => store.get(key) ?? null),
    setJson: vi.fn(async (key: string, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    }),
    delByPrefix: vi.fn(async (prefix: string) => {
      let deleted = 0;
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    }),
  };

  const service = new AdminDashboardService(
    { db: { $queryRaw: queryRaw } } as unknown as PrismaService,
    redis as unknown as RedisService,
  );

  return { service, queryRaw, redis, store, sqlTexts };
}

describe('成功率口径', () => {
  it('分母只含 SUCCEEDED + PARTIAL + FAILED', () => {
    expect(successRate(8, 1, 1)).toBe(80);
    // PARTIAL 计入分母但不计入分子
    expect(successRate(1, 1, 0)).toBe(50);
    expect(successRate(0, 0, 0)).toBe(0);
  });
});

describe('AdminDashboardService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('成功率不把 QUEUED / RUNNING / UNKNOWN 计入分母', async () => {
    const view = await harness.service.getDashboard(QUERY);

    // 区间内共 20 个任务,但可判定成败的只有 8 + 1 + 1 = 10 个
    expect(view.totals.generationTasks.value).toBe(20);
    expect(view.breakdown.generationRateDenominator.value).toBe(10);
    expect(view.totals.generationSuccessRate.value).toBe(80);

    // 口径文案必须显式说明排除项,前端会原样展示
    const definition = view.totals.generationSuccessRate.definition;
    expect(definition).toContain('SUCCEEDED / (SUCCEEDED + PARTIAL + FAILED)');
    for (const excluded of ['QUEUED', 'RUNNING', 'CANCELED', 'TIMEOUT', 'UNKNOWN']) {
      expect(definition).toContain(excluded);
    }
  });

  it('聚合 SQL 只按 SUCCEEDED / PARTIAL / FAILED 分桶,不出现未终态状态', async () => {
    await harness.service.getDashboard(QUERY);

    const aggregateSql = harness.sqlTexts.filter((text) => text.includes('FILTER (WHERE status'));
    expect(aggregateSql.length).toBeGreaterThan(0);
    for (const text of aggregateSql) {
      expect(text).toContain("status = 'SUCCEEDED'");
      expect(text).not.toContain("status = 'QUEUED'");
      expect(text).not.toContain("status = 'RUNNING'");
      expect(text).not.toContain("status = 'UNKNOWN'");
    }
  });

  it('按天分桶并补齐零值,成功率曲线与总量同口径', async () => {
    const view = await harness.service.getDashboard(QUERY);

    expect(view.trends.newUsers.map((p) => p.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ]);
    expect(view.trends.newUsers.map((p) => p.value)).toEqual([5, 0, 0]);
    // 该桶 4 成功 / 1 失败 -> 80;其余桶无可判定任务 -> 0
    expect(view.extraTrends.successRate.map((p) => p.value)).toEqual([0, 80, 0]);
    expect(view.trends.tasks[1]).toMatchObject({ succeeded: 4, failed: 1, total: 10 });
  });

  it('存储字节以字符串返回,避免精度丢失', async () => {
    const view = await harness.service.getDashboard(QUERY);
    expect(view.totals.storageBytes.value).toBe('123456789012');
    expect(view.breakdown.storageRecycledBytes.value).toBe('1024');
  });

  it('统计走 60 秒缓存,key 含区间与粒度;refresh 后重新聚合', async () => {
    await harness.service.getDashboard(QUERY);
    const callsAfterFirst = harness.queryRaw.mock.calls.length;
    expect(callsAfterFirst).toBe(6);

    // 第二次命中缓存,不再打库
    await harness.service.getDashboard(QUERY);
    expect(harness.queryRaw.mock.calls.length).toBe(callsAfterFirst);

    const cacheKeys = [...harness.store.keys()];
    expect(cacheKeys).toHaveLength(1);
    expect(cacheKeys[0]).toContain('2026-09-01_2026-09-03');
    expect(cacheKeys[0]).toContain('day');

    await harness.service.refresh();
    expect(harness.store.size).toBe(0);
    await harness.service.getDashboard(QUERY);
    expect(harness.queryRaw.mock.calls.length).toBe(callsAfterFirst * 2);
  });

  it('不同粒度使用不同缓存 key', async () => {
    await harness.service.getDashboard(QUERY);
    await harness.service.getDashboard({ ...QUERY, granularity: 'week' });
    expect(harness.store.size).toBe(2);
  });

  it('区间超过 90 天直接拒绝,而不是悄悄截断', async () => {
    await expect(
      harness.service.getDashboard({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
        granularity: 'day',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('聚合 SQL 全部走绑定参数,不做字符串拼接', async () => {
    await harness.service.getDashboard(QUERY);

    for (const text of harness.sqlTexts) {
      // 时间区间以 $1/$2 形式出现,SQL 文本里不应出现任何日期字面量
      expect(text).toMatch(/\$\d+/);
      expect(text).not.toContain('2026-09-01T');
    }
  });
});
