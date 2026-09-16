'use client';

import {
  ALLOWED_IMPORT_MIME_TYPES,
  type ImportJobStatus,
  type ProductImportPreview,
  type ProductImportRowError,
} from '@june/shared';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { EmptyState, ErrorState } from '@/components/feedback/states';
import { UploadProgressList } from '@/components/feedback/upload-progress';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/toggle';
import { api } from '@/lib/api/client';
import { describeError } from '@/lib/api/errors';

import { useAssetUpload } from '../hooks/use-asset-upload';
import { useShopOptions } from '../hooks/use-options';
import { useImportJob } from '../hooks/use-products';
import type { ImportEnqueueResult } from '../lib/api-types';
import { CSV_PREVIEW_ROWS, buildCsvTemplate, buildRowErrorReport, parseCsvForPreview, type LocalCsvPreview } from '../lib/csv';
import { downloadTextFile } from '../lib/download';
import { PRODUCT_ERROR_COPY, describeWithOverrides } from '../lib/error-copy';

import { InlineAlert } from './inline-alert';

type DuplicateStrategy = 'skip' | 'update' | 'fail';

function csvMime(file: File): string {
  if ((ALLOWED_IMPORT_MIME_TYPES as readonly string[]).includes(file.type)) return file.type;
  return 'text/csv';
}

export function ProductImportPage(): React.JSX.Element {
  const shops = useShopOptions();
  const upload = useAssetUpload();
  const [shopId, setShopId] = useState<string | null>(null);
  const [localPreview, setLocalPreview] = useState<LocalCsvPreview | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileAssetId, setFileAssetId] = useState<string | null>(null);
  const [serverPreview, setServerPreview] = useState<ProductImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [duplicateStrategy, setDuplicateStrategy] = useState<DuplicateStrategy>('skip');
  const [continueOnRowError, setContinueOnRowError] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useImportJob(jobId);

  async function onPickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setFileName(file.name);
    setServerPreview(null);
    setJobId(null);
    setFileAssetId(null);
    try {
      const preview = await parseCsvForPreview(file);
      setLocalPreview(preview);
    } catch (error) {
      toast.error(describeError(error));
      return;
    }
    const assets = await upload.upload(
      [new File([file], file.name, { type: csvMime(file) })],
      'IMPORT_FILE',
    );
    const asset = assets[0];
    if (asset) setFileAssetId(asset.id);
  }

  async function runPreview(): Promise<void> {
    if (!shopId || !fileAssetId) {
      toast.error('请先选择店铺并上传 CSV');
      return;
    }
    setPreviewing(true);
    try {
      const result = await api.post<ProductImportPreview>('/products/import/preview', {
        shopId,
        fileAssetId,
      });
      setServerPreview(result);
      toast.success(`后端已预检 ${result.totalRows} 行`);
    } catch (error) {
      toast.error(describeWithOverrides(error, PRODUCT_ERROR_COPY));
    } finally {
      setPreviewing(false);
    }
  }

  async function commit(): Promise<void> {
    if (!shopId || !fileAssetId) {
      toast.error('请先完成预检');
      return;
    }
    setCommitting(true);
    try {
      const result = await api.post<ImportEnqueueResult>('/products/import', {
        shopId,
        fileAssetId,
        duplicateStrategy,
        continueOnRowError,
      });
      setJobId(result.jobId);
      toast.success(`已入队,共 ${result.totalRows} 行`);
    } catch (error) {
      toast.error(describeWithOverrides(error, PRODUCT_ERROR_COPY));
    } finally {
      setCommitting(false);
    }
  }

  const localErrors = localPreview?.errors.slice(0, CSV_PREVIEW_ROWS) ?? [];
  const serverErrors = serverPreview?.errors ?? [];
  const jobErrors = job.data?.rowErrors ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="导入商品"
        description="先本地下载模板并预览前 20 行错误,再交给后端预检与入队。权威校验始终在后端。"
        breadcrumbs={[{ label: '商品', href: '/workbench/products' }, { label: '导入' }]}
        actions={
          <Button
            variant="secondary"
            iconLeft={<Download size={16} />}
            onClick={() => downloadTextFile(buildCsvTemplate(), '商品导入模板.csv')}
          >
            下载模板
          </Button>
        }
      />

      {shops.isError ? <ErrorState error={shops.error} onRetry={() => void shops.refetch()} /> : null}
      {shops.data && shops.data.length === 0 ? (
        <EmptyState title="请先创建店铺" description="导入必须指定目标店铺。" />
      ) : (
        <Field label="目标店铺" htmlFor="import-shop" required>
          <Select
            id="import-shop"
            value={shopId}
            onChange={setShopId}
            options={(shops.data ?? []).map((shop) => ({ value: shop.id, label: shop.name }))}
            placeholder="选择店铺"
          />
        </Field>
      )}

      <Card>
        <CardHeader>
          <CardTitle as="h2">选择 CSV</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-6 text-sm text-fg-muted hover:bg-surface-hover">
            <FileSpreadsheet size={20} aria-hidden />
            <span>{fileName ?? '选择 CSV 文件'}</span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(event) => {
                void onPickFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          <UploadProgressList items={upload.items} onRemove={upload.removeItem} onRetry={upload.retryItem} />
        </CardContent>
      </Card>

      {localPreview ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">本地预览</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-fg-muted">
              共 {localPreview.totalRows} 行,展示前 {Math.min(CSV_PREVIEW_ROWS, localPreview.sample.length)} 行。
            </p>
            {localPreview.missingRequiredColumns.length > 0 ? (
              <InlineAlert>缺少必填列：{localPreview.missingRequiredColumns.join('、')}</InlineAlert>
            ) : null}
            {localPreview.unknownColumns.length > 0 ? (
              <InlineAlert tone="warning">未识别列将被忽略：{localPreview.unknownColumns.join('、')}</InlineAlert>
            ) : null}
            {localPreview.parseWarnings.length > 0 ? (
              <InlineAlert tone="warning">{localPreview.parseWarnings.join('；')}</InlineAlert>
            ) : null}
            <SampleTable rows={localPreview.sample} />
            <ErrorList errors={localErrors} emptyLabel="前 20 行未发现本地可提前识别的错误" />
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={previewing || upload.uploading}
          disabled={!shopId || !fileAssetId}
          iconLeft={<Upload size={16} />}
          onClick={() => void runPreview()}
        >
          后端预检
        </Button>
      </div>

      {serverPreview ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">后端预检</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-fg-muted">
              共 {serverPreview.totalRows} 行,上限 {serverPreview.maxRows}。
            </p>
            {serverPreview.missingRequiredColumns.length > 0 ? (
              <InlineAlert>缺少必填列：{serverPreview.missingRequiredColumns.join('、')}</InlineAlert>
            ) : null}
            <SampleTable rows={serverPreview.sample} />
            <ErrorList errors={serverErrors} emptyLabel="后端预检未返回逐行错误" />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="重复 SKU" htmlFor="dup-strategy">
          <Select
            id="dup-strategy"
            value={duplicateStrategy}
            onChange={(value) => setDuplicateStrategy(value as DuplicateStrategy)}
            options={[
              { value: 'skip', label: '跳过重复行' },
              { value: 'update', label: '更新已有商品' },
              { value: 'fail', label: '遇到重复即失败' },
            ]}
          />
        </Field>
        <div className="flex items-center justify-between rounded-md border border-border-default px-3 py-2">
          <div>
            <p className="text-sm text-fg">校验失败时继续其余行</p>
            <p className="text-xs text-fg-muted">关闭后遇错即停止</p>
          </div>
          <Switch checked={continueOnRowError} onChange={setContinueOnRowError} aria-label="校验失败时继续其余行" />
        </div>
      </div>

      <Button loading={committing} disabled={!shopId || !fileAssetId} onClick={() => void commit()}>
        提交导入
      </Button>

      {job.isError ? <ErrorState error={job.error} onRetry={() => void job.refetch()} /> : null}
      {job.data ? <ImportJobPanel job={job.data} /> : null}

      {jobErrors.length > 0 ? (
        <Button
          variant="ghost"
          iconLeft={<Download size={16} />}
          onClick={() => downloadTextFile(buildRowErrorReport(jobErrors), '导入错误报告.csv')}
        >
          下载错误报告
        </Button>
      ) : null}
    </div>
  );
}

function SampleTable({ rows }: { rows: Array<Record<string, string>> }): React.JSX.Element | null {
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  if (columns.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-md border border-border-default">
      <table className="min-w-full text-left text-xs">
        <thead className="bg-bg-elevated text-fg-muted">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-2 py-1.5 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, CSV_PREVIEW_ROWS).map((row, index) => (
            <tr key={index} className="border-t border-border-default">
              {columns.map((column) => (
                <td key={column} className="max-w-40 truncate px-2 py-1.5 text-fg">
                  {row[column] || '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorList({ errors, emptyLabel }: { errors: ProductImportRowError[]; emptyLabel: string }): React.JSX.Element {
  if (errors.length === 0) {
    return <p className="text-sm text-fg-muted">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {errors.map((error, index) => (
        <li key={`${error.row}-${error.field}-${index}`} className="text-state-danger-fg">
          第 {error.row} 行{error.field ? ` · ${error.field}` : ''}：{error.message}
        </li>
      ))}
    </ul>
  );
}

function ImportJobPanel({ job }: { job: ImportJobStatus }): React.JSX.Element {
  const percent = job.totalRows > 0 ? Math.round((job.processedRows / job.totalRows) * 100) : null;
  const running = job.status === 'PENDING' || job.status === 'VALIDATING' || job.status === 'RUNNING';

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle as="h2">导入作业</CardTitle>
        <StatusBadge status={job.status} />
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="tabular text-sm text-fg-muted">
          已处理 {job.processedRows}/{job.totalRows} · 成功 {job.successRows} · 失败 {job.failedRows}
        </p>
        <Progress value={running ? percent : job.totalRows > 0 ? 100 : null} aria-label="导入进度" />
        {job.errorMessage ? <InlineAlert>{job.errorMessage}</InlineAlert> : null}
        {job.status === 'PARTIAL' ? <Badge tone="warning">部分行失败,已导入成功的行会保留</Badge> : null}
        <ErrorList errors={job.rowErrors} emptyLabel="暂无逐行错误" />
      </CardContent>
    </Card>
  );
}
