'use client';

import { formatBytes } from '@june/shared';
import { HardDrive } from 'lucide-react';

import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { InfoHint } from '@/components/ui/tooltip';

import { useStorageUsage } from '../hooks/use-storage';

import { InlineAlert } from './inline-alert';

export function StorageUsagePage(): React.JSX.Element {
  const usage = useStorageUsage();

  return (
    <div className="space-y-4">
      <PageHeader
        title="存储"
        description="用量与配额来自后端实时统计。百分比由已用字节 / 配额计算,不会编造。"
        breadcrumbs={[{ label: '工作台', href: '/workbench' }, { label: '存储' }]}
      />

      {usage.isPending ? <LoadingState message="加载存储用量" /> : null}
      {usage.isError ? <ErrorState error={usage.error} onRetry={() => void usage.refetch()} /> : null}
      {usage.data ? <StorageUsageCard usage={usage.data} /> : null}
      {usage.data && usage.data.assetCount === 0 ? (
        <EmptyState icon={<HardDrive size={22} />} title="还没有存储占用" description="上传参考图、商品图或生成图片后会出现在这里。" />
      ) : null}
    </div>
  );
}

export function StorageUsageCard({
  usage,
}: {
  usage: {
    bytesUsed: string;
    quotaBytes: string;
    assetCount: number;
    recycledBytes: string;
    usedPercent: number;
    growthBytes30d: string;
  };
}): React.JSX.Element {
  const overQuota = usage.usedPercent >= 100;

  return (
    <div className="space-y-4">
      {overQuota ? (
        <InlineAlert>已超出存储配额,新的上传会被拒绝。请先清理不用的图片。</InlineAlert>
      ) : usage.usedPercent >= 80 ? (
        <InlineAlert tone="warning">存储用量已超过 80%,接近配额上限。</InlineAlert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="已用" value={formatBytes(usage.bytesUsed)} />
        <Metric label="配额" value={formatBytes(usage.quotaBytes)} />
        <Metric label="资产数量" value={String(usage.assetCount)} />
        <Metric
          label={
            <span className="inline-flex items-center gap-1">
              近 30 天增长
              <InfoHint>统计最近 30 天新增且仍计入用量的字节数,不含回收站中待清除的文件。</InfoHint>
            </span>
          }
          value={formatBytes(usage.growthBytes30d)}
        />
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-fg-muted">用量占比</span>
            <span className="tabular text-fg">{usage.usedPercent}%</span>
          </div>
          <Progress value={usage.usedPercent} aria-label="存储用量" />
          <p className="text-xs text-fg-subtle">回收站占用 {formatBytes(usage.recycledBytes)},回收期内不计入配额释放。</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: React.ReactNode; value: string }): React.JSX.Element {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-fg-muted">{label}</p>
        <p className="mt-1 text-xl font-semibold tabular text-fg">{value}</p>
      </CardContent>
    </Card>
  );
}
