'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, ArrowUpRight, CheckCircle2, HardDrive, RefreshCw, Users } from 'lucide-react';
import Link from 'next/link';

import { adminApi } from '@/features/admin/api/client';
import { adminKeys } from '@/features/admin/api/keys';
import { ADMIN_PATHS } from '@/features/admin/api/paths';
import type {
  AdminDashboardView,
  AdminStorageOverviewView,
  AdminTaskStatsResponse,
} from '@/features/admin/api/types';
import { DistributionChart } from '@/features/admin/components/distribution-chart';
import { MetricCard, formatMetricValue } from '@/features/admin/components/metric-card';
import { TaskOutcomeChart } from '@/features/admin/components/task-outcome-chart';
import { TrendChart } from '@/features/admin/components/trend-chart';
import { useUrlFilters } from '@/features/admin/hooks/use-url-filters';
import { buildTaskOutcomes, mergeUserTrends } from '@/features/admin/lib/dashboard-data';
import {
  bytesToNumber,
  formatBytes,
  formatDuration,
  formatInteger,
  formatRate,
} from '@/features/admin/lib/format';
import { ASSET_KIND_LABELS, labelOf } from '@/features/admin/lib/labels';
import { compactQuery, dateToIsoEnd, dateToIsoStart } from '@/features/admin/lib/query';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDateTime } from '@/lib/utils';

const FILTERS = { from: '', to: '' };

export function DashboardScreen(): React.JSX.Element {
  const { filters, setFilters, resetFilters, isFiltered } = useUrlFilters(FILTERS);
  const invalidRange = Boolean(filters.from && filters.to && filters.from > filters.to);
  const queryParams = compactQuery({ from: dateToIsoStart(filters.from), to: dateToIsoEnd(filters.to) });
  const dashboardQuery = useQuery({
    queryKey: adminKeys.dashboard(queryParams),
    queryFn: ({ signal }) =>
      adminApi.get<AdminDashboardView>(ADMIN_PATHS.dashboard.overview, { signal, query: queryParams }),
    enabled: !invalidRange,
  });
  const taskStatsQuery = useQuery({
    queryKey: adminKeys.taskStats(queryParams),
    queryFn: ({ signal }) =>
      adminApi.get<AdminTaskStatsResponse>(ADMIN_PATHS.tasks.stats, { signal, query: queryParams }),
    enabled: !invalidRange,
  });
  const storageQuery = useQuery({
    queryKey: adminKeys.storageOverview({ topN: 8 }),
    queryFn: ({ signal }) =>
      adminApi.get<AdminStorageOverviewView>(ADMIN_PATHS.storage.overview, { signal, query: { topN: 8 } }),
  });
  const refresh = useMutation({
    mutationFn: async () => {
      await adminApi.get(ADMIN_PATHS.dashboard.refresh);
      await Promise.all([dashboardQuery.refetch(), taskStatsQuery.refetch(), storageQuery.refetch()]);
    },
  });
  const data = invalidRange ? undefined : dashboardQuery.data;
  const models = [...(taskStatsQuery.data?.rows ?? [])]
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
  const modelTotal = (taskStatsQuery.data?.rows ?? []).reduce((sum, row) => sum + row.total, 0);
  const taskLinkQuery = new URLSearchParams({ onlyFailed: 'true' });
  if (filters.from) taskLinkQuery.set('from', filters.from);
  if (filters.to) taskLinkQuery.set('to', filters.to);

  const presets = [7, 30, 90].map((days) => {
    const to = new Date();
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - days + 1);
    return { days, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="运营概览"
        description="掌握用户增长、创作表现与平台资源使用情况。"
        actions={
          <Button
            variant="outline"
            size="sm"
            iconLeft={<RefreshCw size={14} />}
            loading={refresh.isPending}
            disabled={invalidRange}
            onClick={() => refresh.mutate()}
          >
            刷新数据
          </Button>
        }
      />

      <div className="flex flex-wrap items-end justify-between gap-4 rounded-lg border border-border-default bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-2 text-xs font-medium text-fg-muted">查看时段</span>
          {presets.map((preset) => {
            const selected =
              (filters.from || data?.range.from.slice(0, 10)) === preset.from &&
              (filters.to || data?.range.to.slice(0, 10)) === preset.to;
            return (
              <Button
                key={preset.days}
                variant={selected ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={selected}
                onClick={() => setFilters({ from: preset.from, to: preset.to })}
              >
                近 {preset.days} 天
              </Button>
            );
          })}
          {isFiltered ? (
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              重置
            </Button>
          ) : null}
        </div>
        <div className="grid w-full grid-cols-2 items-end gap-3 sm:w-auto">
          <label className="min-w-0 text-xs text-fg-muted">
            开始日期
            <Input
              type="date"
              className="mt-1 block w-full min-w-0 sm:w-36"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(event) => setFilters({ from: event.target.value })}
            />
          </label>
          <label className="min-w-0 text-xs text-fg-muted">
            结束日期
            <Input
              type="date"
              className="mt-1 block w-full min-w-0 sm:w-36"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(event) => setFilters({ to: event.target.value })}
            />
          </label>
        </div>
      </div>
      {invalidRange ? (
        <p role="alert" className="text-sm text-state-danger-fg">
          结束日期不能早于开始日期。
        </p>
      ) : null}
      {refresh.isError ? <ErrorState error={refresh.error} onRetry={() => refresh.mutate()} /> : null}
      {dashboardQuery.isPending && !invalidRange ? <LoadingState message="加载运营数据" /> : null}
      {dashboardQuery.isError && !invalidRange ? (
        <ErrorState error={dashboardQuery.error} onRetry={() => void dashboardQuery.refetch()} />
      ) : null}

      {data ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-subtle">
            <p>
              统计时段：{data.range.from.slice(0, 10)} 至 {data.range.to.slice(0, 10)}
            </p>
            <p>更新于 {formatDateTime(data.computedAt)}</p>
          </div>
          <section aria-label="关键指标" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              label="新增用户"
              value={formatInteger(data.totals.newUsers.value)}
              icon={<Users size={18} />}
              hint={`当前用户总数 ${formatInteger(data.totals.users.value)}`}
            />
            <MetricCard
              label="活跃用户"
              value={formatInteger(data.totals.activeUsers.value)}
              icon={<Activity size={18} />}
              hint="所选时段内访问过平台的用户"
            />
            <MetricCard
              label="生成任务"
              value={formatInteger(data.totals.generationTasks.value)}
              icon={<CheckCircle2 size={18} />}
              hint={`失败 ${formatInteger(data.breakdown.generationFailed.value)} · 部分成功 ${formatInteger(data.breakdown.generationPartial.value)}`}
            />
            <MetricCard
              label="任务成功率"
              value={
                data.breakdown.generationRateDenominator.value > 0
                  ? formatRate(data.totals.generationSuccessRate.value)
                  : '—'
              }
              icon={<Activity size={18} />}
              hint={
                data.breakdown.generationRateDenominator.value > 0
                  ? '完整成功占已判定结果任务的比例'
                  : '暂无已完成任务'
              }
            />
          </section>

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <TrendChart
              title="用户增长与活跃"
              description="查看新增用户与活跃用户随时间的变化"
              data={mergeUserTrends(data.trends.newUsers, data.trends.activeUsers)}
              series={[
                { key: 'newUsers', name: '新增用户', colorClass: 'accent' },
                { key: 'activeUsers', name: '活跃用户', colorClass: 'purple' },
              ]}
            />
            <TrendChart
              title="创作任务趋势"
              description="对比生成需求与失败任务，及时发现异常"
              data={data.trends.tasks.map((point) => ({ ...point }))}
              series={[
                { key: 'total', name: '任务总数', colorClass: 'accent' },
                { key: 'failed', name: '失败任务', colorClass: 'danger' },
              ]}
            />
          </div>

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <TaskOutcomeChart
              items={buildTaskOutcomes(
                data.totals.generationTasks.value,
                data.breakdown.generationSucceeded.value,
                data.breakdown.generationPartial.value,
                data.breakdown.generationFailed.value,
              )}
            />
            <section className="min-w-0 rounded-lg border border-border-default bg-surface p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">热门模型</h2>
                  <p className="mt-1 text-xs text-fg-muted">按任务量排名 · 同时关注成功率与响应速度</p>
                </div>
                <Link href="/admin/tasks" className="shrink-0 text-xs text-accent hover:underline">
                  查看全部
                </Link>
              </div>
              {taskStatsQuery.isPending ? (
                <LoadingState message="加载模型数据" />
              ) : taskStatsQuery.isError ? (
                <ErrorState error={taskStatsQuery.error} onRetry={() => void taskStatsQuery.refetch()} />
              ) : models.length === 0 ? (
                <p className="flex h-64 items-center justify-center text-sm text-fg-subtle">
                  所选时段暂无模型调用
                </p>
              ) : (
                <ol className="mt-5 space-y-4">
                  {models.map((model, index) => (
                    <li key={`${model.providerSlug}:${model.modelKey}`} className="flex gap-3">
                      <span className="pt-0.5 text-xs font-medium tabular text-fg-subtle">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between gap-3 text-sm">
                          <span
                            className="truncate font-medium"
                            title={`${model.providerSlug} · ${model.modelKey}`}
                          >
                            {model.modelDisplayName ?? model.modelKey}
                          </span>
                          <span className="shrink-0 tabular">
                            {formatInteger(model.total)} <span className="text-xs text-fg-muted">次</span>
                          </span>
                        </div>
                        <div className="my-2 h-1.5 overflow-hidden rounded-full bg-accent-surface">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${(model.total / (models[0]?.total || 1)) * 100}%` }}
                          />
                        </div>
                        <p className="flex flex-wrap justify-between gap-1 text-xs text-fg-subtle">
                          <span>
                            成功率 {model.rateDenominator > 0 ? formatRate(model.successRate) : '—'} ·
                            响应中位耗时 {formatDuration(model.p50UpstreamMs)}
                          </span>
                          <span>任务占比 {formatRate((model.total / modelTotal) * 100)}</span>
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section aria-label="平台资源" className="space-y-3">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="text-fg-muted" />
              <h2 className="text-sm font-semibold">平台资源</h2>
              <span className="text-xs text-fg-subtle">当前总量</span>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCard
                label="店铺 / 商品"
                value={`${formatInteger(data.totals.shops.value)} / ${formatInteger(data.totals.products.value)}`}
                hint={`主店 ${formatInteger(data.breakdown.shopsMain.value)} · 子店 ${formatInteger(data.breakdown.shopsSub.value)}`}
              />
              <MetricCard
                label="社区帖子"
                value={formatInteger(data.totals.posts.value)}
                hint={`已发布 ${formatInteger(data.breakdown.postsPublished.value)} · 草稿 ${formatInteger(data.breakdown.postsDraft.value)}`}
              />
              <MetricCard
                label="社区评论"
                value={formatInteger(data.totals.comments.value)}
                hint="当前可见评论"
              />
              <MetricCard
                label="文件存储"
                value={formatMetricValue(data.totals.storageBytes.value, 'bytes')}
                hint={`回收站 ${formatBytes(data.breakdown.storageRecycledBytes.value)}`}
              />
            </div>
          </section>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            {storageQuery.isError ? (
              <ErrorState error={storageQuery.error} onRetry={() => void storageQuery.refetch()} />
            ) : (
              <DistributionChart
                title="存储空间分布"
                description="当前各类文件的空间占用"
                items={(storageQuery.data?.byKind ?? []).map((row) => ({
                  key: row.kind,
                  label: labelOf(ASSET_KIND_LABELS, row.kind),
                  value: bytesToNumber(row.bytes),
                }))}
                kind="bytes"
                emptyText={storageQuery.isPending ? '加载存储数据…' : '暂无文件占用'}
              />
            )}
            <section className="rounded-lg border border-border-default bg-surface p-5">
              <h2 className="text-sm font-semibold">待关注事项</h2>
              <p className="mt-1 text-xs text-fg-muted">快速定位需要处理的问题</p>
              <div className="mt-5 space-y-3">
                <AttentionLink
                  href={`/admin/tasks?${taskLinkQuery}`}
                  title="失败任务"
                  value={`${formatInteger(data.breakdown.generationFailed.value)} 个`}
                  detail="检查失败原因与模型服务状态"
                />
                {storageQuery.data ? (
                  <>
                    <AttentionLink
                      href="/admin/storage"
                      title="可清理文件"
                      value={formatBytes(storageQuery.data.pendingCleanup.dueBytes)}
                      detail={`${formatInteger(storageQuery.data.pendingCleanup.dueAssetCount)} 个文件已超过回收保留期`}
                    />
                    <AttentionLink
                      href="/admin/storage"
                      title="存储超额用户"
                      value={`${formatInteger(storageQuery.data.quotaExceededUsers.length)}${storageQuery.data.quotaExceededUsers.length >= 100 ? '+' : ''} 人`}
                      detail="查看用量并调整配额"
                    />
                  </>
                ) : (
                  <p className="py-3 text-xs text-fg-subtle">
                    {storageQuery.isError ? '存储提醒暂不可用，请重试存储统计。' : '正在加载存储提醒…'}
                  </p>
                )}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function AttentionLink({
  href,
  title,
  value,
  detail,
}: {
  href: string;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-lg border border-border-default p-3 transition-colors hover:bg-accent-surface"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-fg-muted">{detail}</p>
      </div>
      <span className="shrink-0 text-sm font-semibold tabular">{value}</span>
      <ArrowUpRight size={16} className="shrink-0 text-fg-subtle group-hover:text-accent" />
    </Link>
  );
}
