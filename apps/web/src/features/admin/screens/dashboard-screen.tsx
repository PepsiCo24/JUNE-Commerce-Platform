'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type { AdminDashboardView, DashboardMeta } from '@/features/admin/api/types';
import { MetricCard, formatMetricValue } from '@/features/admin/components/metric-card';
import { TrendChart } from '@/features/admin/components/trend-chart';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { bytesToNumber, formatInteger } from '@/features/admin/lib/format';
import { compactQuery, dateToIsoEnd, dateToIsoStart } from '@/features/admin/lib/query';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { from: '', to: '', granularity: 'day' };

export function DashboardScreen(): React.JSX.Element {
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);

  const queryParams = compactQuery({
    from: dateToIsoStart(filters.from),
    to: dateToIsoEnd(filters.to),
    granularity: filters.granularity,
  });

  const metaQuery = useQuery({
    queryKey: adminKeys.dashboardMeta,
    queryFn: ({ signal }) => adminApi.get<DashboardMeta>(ADMIN_PATHS.dashboard.meta, { signal }),
  });

  const dashboardQuery = useQuery({
    queryKey: adminKeys.dashboard(queryParams),
    queryFn: ({ signal }) =>
      adminApi.get<AdminDashboardView>(ADMIN_PATHS.dashboard.overview, { signal, query: queryParams }),
  });

  const data = dashboardQuery.data;

  const userTrend = useMemo(
    () =>
      (data?.trends.newUsers ?? []).map((point, index) => ({
        date: point.date,
        newUsers: point.value,
        activeUsers: data?.trends.activeUsers[index]?.value ?? 0,
      })),
    [data],
  );

  const postTrend = useMemo(
    () => (data?.trends.posts ?? []).map((point) => ({ date: point.date, posts: point.value })),
    [data],
  );

  const taskTrend = useMemo(
    () =>
      (data?.trends.tasks ?? []).map((point) => ({
        date: point.date,
        succeeded: point.succeeded,
        failed: point.failed,
        total: point.total,
      })),
    [data],
  );

  const rateTrend = useMemo(
    () => (data?.extraTrends.successRate ?? []).map((point) => ({ date: point.date, successRate: point.value })),
    [data],
  );

  const storageTrend = useMemo(
    () =>
      (data?.extraTrends.storageBytes ?? []).map((point) => ({
        date: point.date,
        storageBytes: bytesToNumber(point.value),
      })),
    [data],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="仪表盘"
        description="数字均附带口径。区间按 UTC 自然日对齐,未填日期时默认最近 30 天。"
        actions={
          <Button
            variant="outline"
            size="sm"
            iconLeft={<RefreshCw size={14} />}
            loading={dashboardQuery.isFetching && !dashboardQuery.isPending}
            onClick={() =>
              void adminApi
                .get(ADMIN_PATHS.dashboard.refresh, { query: queryParams })
                .then(() => dashboardQuery.refetch())
            }
          >
            刷新统计
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-fg-muted">
          开始
          <Input
            type="date"
            className="mt-1"
            value={filters.from}
            onChange={(event) => setFilters({ from: event.target.value })}
          />
        </label>
        <label className="text-xs text-fg-muted">
          结束
          <Input
            type="date"
            className="mt-1"
            value={filters.to}
            onChange={(event) => setFilters({ to: event.target.value })}
          />
        </label>
        <div className="w-36">
          <Select
            aria-label="趋势粒度"
            value={filters.granularity}
            onChange={(value) => setFilters({ granularity: value })}
            options={[
              { value: 'day', label: '按天' },
              { value: 'week', label: '按周' },
            ]}
          />
        </div>
        {isFiltered ? (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            清空筛选
          </Button>
        ) : null}
        {metaQuery.data ? (
          <p className="text-xs text-fg-subtle">最长 {metaQuery.data.maxRangeDays} 天 · 缓存 {metaQuery.data.cacheTtlSeconds} 秒</p>
        ) : null}
      </div>

      {dashboardQuery.isPending ? <LoadingState message="加载统计" /> : null}
      {dashboardQuery.isError ? <ErrorState error={dashboardQuery.error} onRetry={() => void dashboardQuery.refetch()} /> : null}

      {data ? (
        <>
          <p className="text-xs text-fg-subtle">
            计算于 {formatDateTime(data.computedAt)}
            {data.cacheTtlSeconds > 0 ? ` · 缓存 ${data.cacheTtlSeconds} 秒` : ''}
          </p>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard label="用户" value={formatMetricValue(data.totals.users.value)} definition={data.totals.users.definition} />
            <MetricCard label="新增用户" value={formatMetricValue(data.totals.newUsers.value)} definition={data.totals.newUsers.definition} />
            <MetricCard label="活跃用户" value={formatMetricValue(data.totals.activeUsers.value)} definition={data.totals.activeUsers.definition} />
            <MetricCard label="店铺" value={formatMetricValue(data.totals.shops.value)} definition={data.totals.shops.definition} hint={`主店 ${formatInteger(data.breakdown.shopsMain.value)} · 子店 ${formatInteger(data.breakdown.shopsSub.value)}`} />
            <MetricCard label="商品" value={formatMetricValue(data.totals.products.value)} definition={data.totals.products.definition} />
            <MetricCard label="帖子" value={formatMetricValue(data.totals.posts.value)} definition={data.totals.posts.definition} hint={`已发 ${formatInteger(data.breakdown.postsPublished.value)} · 草稿 ${formatInteger(data.breakdown.postsDraft.value)} · 隐藏 ${formatInteger(data.breakdown.postsHidden.value)}`} />
            <MetricCard label="评论" value={formatMetricValue(data.totals.comments.value)} definition={data.totals.comments.definition} />
            <MetricCard label="生成任务" value={formatMetricValue(data.totals.generationTasks.value)} definition={data.totals.generationTasks.definition} hint={`成功 ${formatInteger(data.breakdown.generationSucceeded.value)} · 部分 ${formatInteger(data.breakdown.generationPartial.value)} · 失败 ${formatInteger(data.breakdown.generationFailed.value)}`} />
            <MetricCard label="成功率" value={formatMetricValue(data.totals.generationSuccessRate.value, 'rate')} definition={data.totals.generationSuccessRate.definition} hint={data.breakdown.generationRateDenominator.definition} />
            <MetricCard label="存储" value={formatMetricValue(data.totals.storageBytes.value, 'bytes')} definition={data.totals.storageBytes.definition} hint={`回收站 ${formatMetricValue(data.breakdown.storageRecycledBytes.value, 'bytes')}`} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <TrendChart data={userTrend} series={[{ key: 'newUsers', name: '新增', colorClass: 'accent' }, { key: 'activeUsers', name: '活跃', colorClass: 'purple' }]} definition={data.trendDefinitions.newUsers} />
            <TrendChart data={postTrend} series={[{ key: 'posts', name: '帖子', colorClass: 'accent' }]} definition={data.trendDefinitions.posts} />
            <TrendChart data={taskTrend} series={[{ key: 'succeeded', name: '成功', colorClass: 'accent' }, { key: 'failed', name: '失败', colorClass: 'danger' }, { key: 'total', name: '合计', colorClass: 'muted' }]} definition={data.trendDefinitions.tasks} />
            <TrendChart data={rateTrend} series={[{ key: 'successRate', name: '成功率', colorClass: 'accent' }]} kind="rate" definition={data.trendDefinitions.successRate} />
            <TrendChart data={storageTrend} series={[{ key: 'storageBytes', name: '存储', colorClass: 'purple' }]} kind="bytes" definition={data.trendDefinitions.storageBytes} />
          </div>
        </>
      ) : null}
    </div>
  );
}
