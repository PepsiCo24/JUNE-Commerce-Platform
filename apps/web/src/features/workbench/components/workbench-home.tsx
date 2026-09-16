'use client';

import { formatBytes, type CursorResult, type GenerationTaskView } from '@june/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { api } from '@/lib/api/client';
import { formatDateTime } from '@/lib/utils';

import { WORKBENCH_NAV_ITEMS } from '../lib/nav';
import { workbenchKeys } from '../lib/keys';
import { useStorageUsage } from '../hooks/use-storage';

export function WorkbenchHome(): React.JSX.Element {
  const usage = useStorageUsage();

  const running = useQuery({
    queryKey: workbenchKeys.taskList({ type: 'ALL', status: 'RUNNING', home: true }),
    queryFn: () =>
      api.get<CursorResult<GenerationTaskView>>('/generation/tasks', {
        query: { type: 'ALL', status: 'RUNNING', limit: 5 },
      }),
  });

  const recent = useQuery({
    queryKey: workbenchKeys.taskList({ type: 'ALL', status: 'ALL', home: true }),
    queryFn: () =>
      api.get<CursorResult<GenerationTaskView>>('/generation/tasks', {
        query: { type: 'ALL', status: 'ALL', limit: 5 },
      }),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader title="工作台" description="生图、文案、店铺与商品运营。配额与任务状态来自服务端实时数据。" />

      <section className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle as="h2">存储配额</CardTitle>
            <CardDescription>口径：当前用户 ACTIVE 资产占用 / 配额。</CardDescription>
          </CardHeader>
          <CardContent>
            {usage.isPending ? <LoadingState message="加载用量" /> : null}
            {usage.isError ? <ErrorState error={usage.error} onRetry={() => void usage.refetch()} /> : null}
            {usage.data ? (
              <div className="space-y-3">
                <p className="text-xl font-semibold tabular">
                  {formatBytes(usage.data.bytesUsed)}
                  <span className="text-sm font-normal text-fg-muted"> / {formatBytes(usage.data.quotaBytes)}</span>
                </p>
                <Progress value={Math.round(usage.data.usedPercent)} aria-label="存储使用百分比" />
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/workbench/storage">查看详情</Link>
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">进行中的任务</CardTitle>
            <CardDescription>状态从后端读取，刷新页面可恢复。</CardDescription>
          </CardHeader>
          <CardContent>
            {running.isPending ? <LoadingState message="加载任务" /> : null}
            {running.isError ? <ErrorState error={running.error} onRetry={() => void running.refetch()} /> : null}
            {running.data && running.data.items.length === 0 ? (
              <p className="text-sm text-fg-muted">当前没有运行中的任务。</p>
            ) : null}
            {running.data && running.data.items.length > 0 ? (
              <ul className="space-y-2">
                {running.data.items.map((task) => (
                  <li key={task.id} className="flex items-center justify-between gap-2 text-sm">
                    <Link href={task.type === 'TEXT_COPY' ? `/workbench/copy?task=${task.id}` : `/workbench/image?task=${task.id}`} className="truncate text-accent">
                      {task.model.displayName}
                    </Link>
                    <StatusBadge status={task.status} />
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-fg-muted">入口</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {WORKBENCH_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="june-glass flex items-start gap-3 rounded-lg border border-border-default p-4 transition-transform hover:-translate-y-0.5"
              >
                <Icon size={18} className="mt-0.5 text-accent" aria-hidden />
                <div>
                  <p className="font-medium text-fg">{item.label}</p>
                  <p className="text-sm text-fg-muted">{item.description}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-fg-muted">最近生成</h2>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/workbench/tasks">全部记录</Link>
          </Button>
        </div>
        {recent.isPending ? <LoadingState message="加载记录" /> : null}
        {recent.isError ? <ErrorState error={recent.error} onRetry={() => void recent.refetch()} /> : null}
        {recent.data ? (
          <ul className="divide-y divide-border-default rounded-lg border border-border-default">
            {recent.data.items.map((task) => (
              <li key={task.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate">{task.model.displayName}</p>
                  <p className="text-xs text-fg-subtle">{formatDateTime(task.createdAt)}</p>
                </div>
                <StatusBadge status={task.status} />
              </li>
            ))}
            {recent.data.items.length === 0 ? (
              <li className="px-4 py-6 text-sm text-fg-muted">还没有生成记录。</li>
            ) : null}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
