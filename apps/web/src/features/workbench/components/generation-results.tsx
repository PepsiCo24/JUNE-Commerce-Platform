'use client';

import type { GenerationResultView, GenerationTaskView } from '@june/shared';
import { Download, Eye, RotateCcw, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/states';
import { AssetImage, ImageLightbox } from '@/components/media/asset-image';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api/client';
import { cn, resultGridClass } from '@/lib/utils';

import { useIdempotencyKey } from '../hooks/use-idempotency-key';
import { useModelConfig } from '../hooks/use-model-config';
import { isTerminalStatus, useTaskDetail } from '../hooks/use-task-detail';
import type { BatchDownloadItem } from '../lib/api-types';
import { downloadSequentially, triggerDownload } from '../lib/download';
import { describeSubmitError } from '../lib/form';

import { InlineAlert } from './inline-alert';
import { SaveToProductDialog } from './save-to-product-dialog';
import { TaskStatusBar } from './task-status-bar';

export function ImageResultPanel({
  taskId,
  queuePosition,
}: {
  taskId: string | null;
  queuePosition?: number | null;
}): React.JSX.Element {
  const { query: taskQuery, degraded } = useTaskDetail(taskId);
  const modelConfig = useModelConfig();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const task = taskQuery.data;
  const succeeded = useMemo(
    () => (task?.results ?? []).filter((item) => item.status === 'SUCCEEDED' && item.asset),
    [task],
  );
  const failed = useMemo(() => (task?.results ?? []).filter((item) => item.status === 'FAILED'), [task]);
  const unknown = task?.status === 'UNKNOWN';
  const canRetry = Boolean(task?.retryable && failed.length > 0 && !unknown);
  const retryIdem = useIdempotencyKey(`retry:${taskId ?? ''}:${failed.map((item) => item.seq).join(',')}`);

  const lightboxImages = succeeded.map((item, index) => ({
    id: item.id,
    url: item.asset?.url ?? '',
    previewUrl: item.asset?.previewUrl,
    alt: `结果 ${index + 1}`,
    downloadUrl: item.asset ? `/api/assets/${item.asset.id}/download` : undefined,
  }));

  async function retryFailed(seqs?: number[]): Promise<void> {
    if (!taskId || unknown) return;
    setRetrying(true);
    try {
      const result = await api.post<{ deduplicated: boolean }>(`/generation/image/${taskId}/retry`, {
        seqs: seqs ?? [],
        idempotencyKey: retryIdem.key,
      });
      retryIdem.reset();
      toast.success(result.deduplicated ? '已复用相同重试请求' : '已重试失败项,已成功的图片不会重复生成');
    } catch (error) {
      toast.error(describeSubmitError(
        error,
        modelConfig.data
          ? { running: modelConfig.data.concurrency.imagePerUserRunning, pending: modelConfig.data.concurrency.imagePerUserPending }
          : undefined,
      ));
    } finally {
      setRetrying(false);
    }
  }

  async function downloadAll(): Promise<void> {
    if (!taskId) return;
    try {
      const items = await api.get<BatchDownloadItem[]>(`/generation/tasks/${taskId}/download-batch`);
      if (items.length === 0) {
        toast.error('没有可下载的图片');
        return;
      }
      await downloadSequentially(items.map((item) => ({ url: item.url, fileName: item.fileName })));
      toast.success(`已开始下载 ${items.length} 张`);
    } catch (error) {
      toast.error(describeSubmitError(error));
    }
  }

  if (!taskId) {
    return <EmptyState title="等待提交" description="填写参数后提交,结果会显示在这里。" />;
  }
  if (taskQuery.isPending) return <LoadingState message="加载任务" />;
  if (taskQuery.isError) return <ErrorState error={taskQuery.error} onRetry={() => void taskQuery.refetch()} />;
  if (!task) return <EmptyState title="任务不存在" />;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-fg">生成结果</h2>
          {task.model.isMock ? (
            <Badge tone="warning" size="sm">
              模拟
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" iconLeft={<Eye size={14} />} onClick={() => setParamsOpen(true)}>
            查看生成参数
          </Button>
          {succeeded.length > 0 ? (
            <>
              <Button variant="secondary" size="sm" iconLeft={<Download size={14} />} onClick={() => void downloadAll()}>
                批量下载
              </Button>
              <Button variant="secondary" size="sm" iconLeft={<Save size={14} />} onClick={() => setSaveOpen(true)}>
                保存到商品
              </Button>
            </>
          ) : null}
          {canRetry ? (
            <Button
              variant="outline"
              size="sm"
              loading={retrying}
              iconLeft={<RotateCcw size={14} />}
              onClick={() => void retryFailed()}
            >
              重试失败项
            </Button>
          ) : null}
        </div>
      </div>

      <TaskStatusBar task={task} degraded={degraded} queuePosition={queuePosition} />

      {unknown ? (
        <InlineAlert tone="warning">上游结果待确认,系统正在核对,请勿重复提交或盲目重试。</InlineAlert>
      ) : null}

      {task.results.length === 0 && !isTerminalStatus(task.status) ? (
        <LoadingState message="正在排队或生成" />
      ) : (
        <div className={cn('grid gap-3', resultGridClass(Math.max(task.results.length, 1)))}>
          {task.results.map((result, index) => (
            <ResultCell
              key={result.id}
              result={result}
              index={index}
              taskStatus={task.status}
              onPreview={() => {
                const previewIndex = succeeded.findIndex((item) => item.id === result.id);
                if (previewIndex >= 0) setLightboxIndex(previewIndex);
              }}
              onDownload={() => {
                if (!result.asset) return;
                triggerDownload(`/api/assets/${result.asset.id}/download`, `result-${result.seq + 1}.png`);
              }}
              onRetry={() => void retryFailed([result.seq])}
              retryable={canRetry && result.status === 'FAILED'}
              retrying={retrying}
            />
          ))}
        </div>
      )}

      <ImageLightbox
        open={lightboxIndex !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxIndex(null);
        }}
        images={lightboxImages}
        index={lightboxIndex ?? 0}
        onIndexChange={setLightboxIndex}
        sidebar={
          <dl className="space-y-2">
            <div>
              <dt className="text-xs text-fg-subtle">模型</dt>
              <dd>
                {task.model.displayName}
                {task.model.isMock ? ' · 模拟' : ''}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">提示词</dt>
              <dd className="whitespace-pre-wrap text-fg">{String(task.params.prompt ?? '—')}</dd>
            </div>
          </dl>
        }
      />

      <SaveToProductDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        taskId={taskId}
        resultIds={succeeded.map((item) => item.id)}
      />

      <Dialog open={paramsOpen} onOpenChange={setParamsOpen} theme="dark" title="生成参数" size="lg">
        <pre className="overflow-auto rounded-md bg-bg-elevated p-3 text-xs text-fg-muted">
          {JSON.stringify(
            {
              model: task.model,
              params: task.params,
              referenceImages: task.referenceImages,
            },
            null,
            2,
          )}
        </pre>
      </Dialog>
    </>
  );
}

function ResultCell({
  result,
  index,
  taskStatus,
  onPreview,
  onDownload,
  onRetry,
  retryable,
  retrying,
}: {
  result: GenerationResultView;
  index: number;
  taskStatus: GenerationTaskView['status'];
  onPreview: () => void;
  onDownload: () => void;
  onRetry: () => void;
  retryable: boolean;
  retrying: boolean;
}): React.JSX.Element {
  if (result.status === 'SUCCEEDED' && result.asset) {
    return (
      <div className="overflow-hidden rounded-lg border border-border-default bg-surface">
        <AssetImage
          asset={result.asset}
          variant="preview"
          alt={`结果 ${index + 1}`}
          onClick={onPreview}
          className="w-full"
        />
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-xs text-fg-muted">#{result.seq + 1}</span>
          <Button variant="ghost" size="sm" iconLeft={<Download size={14} />} onClick={onDownload}>
            下载
          </Button>
        </div>
      </div>
    );
  }

  if (taskStatus === 'UNKNOWN') {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-lg border border-state-warning-border bg-state-warning-bg p-3 text-sm text-state-warning-fg">
        第 {result.seq + 1} 张 · 上游结果待确认
      </div>
    );
  }

  if (result.status === 'FAILED') {
    return (
      <div className="flex min-h-40 flex-col justify-between rounded-lg border border-state-danger-border bg-state-danger-bg p-3">
        <div>
          <p className="text-sm font-medium text-state-danger-fg">第 {result.seq + 1} 张失败</p>
          <p className="mt-1 text-xs text-state-danger-fg">{result.errorMessage ?? result.errorCode}</p>
        </div>
        {retryable ? (
          <Button variant="outline" size="sm" loading={retrying} iconLeft={<RotateCcw size={14} />} onClick={onRetry}>
            重试此项
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-40 items-center justify-center rounded-lg border border-border-default bg-surface text-sm text-fg-muted">
      第 {result.seq + 1} 张生成中
    </div>
  );
}
