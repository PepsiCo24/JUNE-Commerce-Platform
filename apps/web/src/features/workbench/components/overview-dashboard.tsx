'use client';

import { formatBytes } from '@june/shared';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatDateTime } from '@/lib/utils';

import { useStorageUsage } from '../hooks/use-storage';
import { useTaskList } from '../hooks/use-task-list';
import { TASK_TYPE_LABEL } from '../lib/format';
import { WORKBENCH_NAV_ITEMS } from '../lib/nav';

import { InlineAlert } from './inline-alert';

export function OverviewDashboard(): React.JSX.Element {
  const usage = useStorageUsage();
  const tasks = useTaskList({ type: 'ALL', status: 'ALL' });
  const active = tasks.items.filter((item) => item.status === 'QUEUED' || item.status === 'RUNNING').slice(0, 8);
  const entries = WORKBENCH_NAV_ITEMS.filter((item) => item.href !== '/workbench/shops/graph');

  return (
    <div className="space-y-6">
      <PageHeader title="工作台" description="查看配额、进行中的任务,并从这里进入各项能力。" />

      {usage.isError ? <ErrorState error={usage.error} onRetry={() => void usage.refetch()} /> : null}
      {usage.isPending ? <LoadingState message="加载配额" /> : null}
      {usage.data ? (
        <Card glass>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle as="h2">存储配额</CardTitle>
              <CardDescription>
                {formatBytes(usage.data.bytesUsed)} / {formatBytes(usage.data.quotaBytes)} · {usage.data.assetCount} 个资产
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/workbench/storage">详情</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {usage.data.usedPercent >= 100 ? (
              <InlineAlert>已超出存储配额,上传会被拒绝。</InlineAlert>
            ) : usage.data.usedPercent >= 80 ? (
              <InlineAlert tone="warning">存储用量已超过 80%。</InlineAlert>
            ) : null}
            <Progress value={usage.data.usedPercent} aria-label="存储用量" />
            <p className="text-xs text-fg-subtle">近 30 天增长 {formatBytes(usage.data.growthBytes30d)}</p>
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">进行中的任务</h2>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/workbench/tasks">全部记录</Link>
          </Button>
        </div>
        {tasks.isError ? <ErrorState error={tasks.error} onRetry={tasks.refetch} /> : null}
        {tasks.isLoading ? <LoadingState message="加载任务" /> : null}
        {!tasks.isLoading && !tasks.isError && active.length === 0 ? (
          <EmptyState title="没有进行中的任务" description="提交生图或文案后,排队与生成中的任务会出现在这里。" />
        ) : null}
        {active.length > 0 ? (
          <ul className="space-y-2">
            {active.map((task) => (
              <li key={task.id}>
                <Link
                  href={
                    task.type === 'TEXT_COPY'
                      ? `/workbench/copy?taskId=${task.id}`
                      : task.type === 'TEXT_TITLE'
                        ? `/workbench/title?taskId=${task.id}`
                        : `/workbench/image?taskId=${task.id}`
                  }
                  className="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-surface px-3 py-2 hover:bg-surface-hover"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-fg">
                      {TASK_TYPE_LABEL[task.type] ?? task.type} · {task.model.displayName}
                    </p>
                    <p className="text-xs text-fg-subtle">{formatDateTime(task.createdAt)}</p>
                  </div>
                  <StatusBadge status={task.status} />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-fg">入口</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className="group">
                <Card interactive className="h-full">
                  <CardHeader>
                    <CardTitle as="h3" className="flex items-center gap-2">
                      <Icon size={18} aria-hidden className="text-accent" />
                      {item.label}
                    </CardTitle>
                    <CardDescription>{item.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex justify-end text-fg-subtle group-hover:text-accent">
                    <ArrowRight size={16} aria-hidden />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
