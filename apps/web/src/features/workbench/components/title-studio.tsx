'use client';

import {
  ERROR_CODES,
  PROMPT_MAX,
  TARGET_PLATFORMS,
  TITLE_COUNT_MAX,
  TITLE_LENGTH_MAX,
  titleGenerateSchema,
  type TaskSubmitResponse,
  type TitleGenerateInput,
  type TitleSaveResponse,
} from '@june/shared';
import { Copy, RefreshCw, Save } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CharCounter, Field, Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api/client';
import { copyToClipboard } from '@/lib/utils';

import { useIdempotencyKey } from '../hooks/use-idempotency-key';
import { resolveActiveModel, useDisabledModelGuard, useModelConfig, useRefreshModelConfig } from '../hooks/use-model-config';
import { useProductOptions, useShopOptions } from '../hooks/use-options';
import { isTerminalStatus, useTaskDetail } from '../hooks/use-task-detail';
import { isCode } from '../lib/error-copy';
import { describeSubmitError, fieldErrorsFromApi, fieldErrorsFromZod } from '../lib/form';

import { InlineAlert } from './inline-alert';
import { TaskStatusBar } from './task-status-bar';

export function TitleStudio(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const taskId = searchParams.get('taskId');

  const modelConfig = useModelConfig();
  const refreshModels = useRefreshModelConfig();
  const { query: taskQuery, degraded } = useTaskDetail(taskId);
  const shops = useShopOptions();

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [shopId, setShopId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(searchParams.get('product'));
  const [productName, setProductName] = useState('');
  const [sellingPointsText, setSellingPointsText] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [targetPlatform, setTargetPlatform] = useState(String(TARGET_PLATFORMS[0]?.value ?? 'other'));
  const [prompt, setPrompt] = useState('');
  const [titleCount, setTitleCount] = useState(5);
  const [maxTitleLength, setMaxTitleLength] = useState(60);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedTitles, setEditedTitles] = useState<string[]>([]);
  const [saveProductId, setSaveProductId] = useState<string | null>(null);
  const resultsRef = useRef<HTMLElement>(null);

  const products = useProductOptions('', shopId);
  const resolved = resolveActiveModel(modelConfig.data, 'title', selectedModelId);
  const model = blocked ? null : resolved.model;
  const locked = resolved.locked;
  const noModels = (modelConfig.data?.titleModels.length ?? 0) === 0;
  const unverified = Boolean(model && !model.limits.verified);

  useDisabledModelGuard(model?.id ?? selectedModelId, () => {
    setSelectedModelId(null);
    setBlocked(true);
  });

  const sellingPoints = sellingPointsText.split('\n').map((l) => l.trim()).filter(Boolean);
  const keywords = keywordsText.split(/[,，、\n]/).map((l) => l.trim()).filter(Boolean);

  const signature = JSON.stringify({
    shopId,
    productId,
    productName,
    sellingPoints,
    keywords,
    targetPlatform,
    prompt,
    titleCount,
    maxTitleLength,
    model: locked ? null : selectedModelId,
  });
  const { key, reset } = useIdempotencyKey(signature);

  const task = taskQuery.data;
  const titleResult = useMemo(() => {
    const result = task?.results.find((item) => item.titles && item.check?.passed);
    return result?.titles ?? null;
  }, [task]);

  const hydratedKey = task?.id ?? '';
  const appliedTaskId = useRef('');
  useEffect(() => {
    if (!titleResult || !hydratedKey || appliedTaskId.current === hydratedKey) return;
    appliedTaskId.current = hydratedKey;
    setEditedTitles(titleResult.titles.map((t) => t.text));
    setSaveProductId((prev) => prev ?? productId);
  }, [hydratedKey, titleResult, productId]);

  useEffect(() => {
    if (submitting || !taskId) return;
    if (task && isTerminalStatus(task.status) && resultsRef.current) {
      resultsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [task?.status, submitting, taskId, task]);

  async function submit(): Promise<void> {
    if (noModels || !model) {
      toast.error('待真实联调：当前没有可用的标题模型');
      return;
    }

    const body: TitleGenerateInput = {
      productId,
      productName: productName || undefined,
      sellingPoints,
      keywords,
      targetPlatform,
      prompt: prompt || undefined,
      titleCount,
      maxTitleLength,
      idempotencyKey: key,
    };
    if (!locked && model.id) body.modelConfigId = model.id;

    const parsed = titleGenerateSchema.safeParse(body);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod(parsed.error));
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    try {
      const result = await api.post<TaskSubmitResponse>('/generation/title', parsed.data);
      reset();
      const params = new URLSearchParams(searchParams.toString());
      params.set('taskId', result.taskId);
      router.replace(`/workbench/title?${params.toString()}`, { scroll: false });
      toast.success(result.deduplicated ? '已复用相同请求的任务' : '标题任务已提交');
    } catch (error) {
      if (isCode(error, ERROR_CODES.MODEL_SELECTION_LOCKED)) refreshModels();
      setFieldErrors(fieldErrorsFromApi(error));
      toast.error(describeSubmitError(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function saveTitle(index: number): Promise<void> {
    if (!saveProductId) {
      toast.error('请选择要保存到的商品');
      return;
    }
    const title = editedTitles[index]?.trim();
    if (!title) {
      toast.error('标题不能为空');
      return;
    }
    setSaving(true);
    try {
      const result = await api.post<TitleSaveResponse>('/title/save', {
        productId: saveProductId,
        title,
        sourceTaskId: taskId,
      });
      if (!result.saved) {
        toast.error('保存前检查未通过');
        return;
      }
      toast.success('标题已保存到商品');
    } catch (error) {
      toast.error(describeSubmitError(error));
    } finally {
      setSaving(false);
    }
  }

  const shopOptions = (shops.data ?? []).map((s) => ({ value: s.id, label: s.name }));
  const productOptions = (products.data ?? []).map((item) => ({
    value: item.id,
    label: item.sku ? `${item.name} (${item.sku})` : item.name,
  }));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <PageHeader
        title="标题生成"
        description="输入商品资料与平台要求,生成候选标题。可编辑、复制并保存到商品。"
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link href="/workbench/title/history">历史记录</Link>
          </Button>
        }
      />

      <section className="space-y-4">
        {modelConfig.isError ? <ErrorState error={modelConfig.error} onRetry={() => void modelConfig.refetch()} /> : null}
        {noModels ? (
          <EmptyState title="待配置标题模型" description="当前没有可用的文本模型,无法提交。不会假装生成成功。" />
        ) : null}
        {unverified ? <InlineAlert tone="warning">当前模型尚未完成真实联调,结果仅供验证。</InlineAlert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="店铺" htmlFor="title-shop">
            <Select
              id="title-shop"
              value={shopId ?? '__none__'}
              onChange={(value) => {
                setShopId(value === '__none__' ? null : value);
                setProductId(null);
              }}
              options={[{ value: '__none__', label: '不关联店铺' }, ...shopOptions]}
            />
          </Field>
          <Field label="商品" htmlFor="title-product" description="先选店铺再搜索商品">
            <Select
              id="title-product"
              value={productId ?? '__none__'}
              onChange={(value) => {
                if (value === '__none__') {
                  setProductId(null);
                  return;
                }
                setProductId(value);
                const picked = products.data?.find((p) => p.id === value);
                if (picked) setProductName(picked.name);
              }}
              options={[{ value: '__none__', label: shopId ? '搜索并选择商品' : '请先选择店铺' }, ...productOptions]}
              disabled={!shopId}
            />
          </Field>
        </div>

        <Field label="商品名称" htmlFor="title-name" error={fieldErrors.productName}>
          <Input id="title-name" value={productName} onChange={(e) => setProductName(e.target.value)} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="目标平台" htmlFor="title-platform">
            <Select
              id="title-platform"
              value={targetPlatform}
              onChange={setTargetPlatform}
              options={TARGET_PLATFORMS.map((p) => ({ value: p.value, label: p.label }))}
            />
          </Field>
          {!locked && resolved.options.length > 1 ? (
            <Field label="模型" htmlFor="title-model">
              <Select
                id="title-model"
                value={selectedModelId ?? model?.id ?? null}
                onChange={(value) => {
                  setBlocked(false);
                  setSelectedModelId(value);
                }}
                options={resolved.options.map((item) => ({
                  value: item.id,
                  label: `${item.displayName}${item.isMock ? ' · 模拟' : ''}`,
                }))}
              />
            </Field>
          ) : null}
        </div>

        <Field label="卖点(每行一条)" htmlFor="title-points">
          <Textarea id="title-points" rows={3} value={sellingPointsText} onChange={(e) => setSellingPointsText(e.target.value)} />
        </Field>

        <Field label="关键词" htmlFor="title-keywords" description="逗号或换行分隔">
          <Input id="title-keywords" value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} />
        </Field>

        <Field label="补充要求" htmlFor="title-prompt">
          <Textarea id="title-prompt" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={PROMPT_MAX} />
          <CharCounter value={prompt} max={PROMPT_MAX} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="候选数量" htmlFor="title-count">
            <Input
              id="title-count"
              type="number"
              min={1}
              max={TITLE_COUNT_MAX}
              value={titleCount}
              onChange={(e) => setTitleCount(Number(e.target.value))}
            />
          </Field>
          <Field label="单条字数上限" htmlFor="title-max-len">
            <Input
              id="title-max-len"
              type="number"
              min={8}
              max={TITLE_LENGTH_MAX}
              value={maxTitleLength}
              onChange={(e) => setMaxTitleLength(Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button loading={submitting} onClick={() => void submit()} disabled={noModels || !model}>
            生成标题
          </Button>
          {taskId ? (
            <Button variant="secondary" iconLeft={<RefreshCw size={16} />} onClick={() => void submit()} disabled={submitting}>
              重新生成
            </Button>
          ) : null}
        </div>
      </section>

      {taskId ? (
        <section ref={resultsRef} className="space-y-4 border-t border-border-default pt-6">
          {task ? <TaskStatusBar task={task} degraded={degraded} /> : null}
          {taskQuery.isLoading ? <LoadingState message="加载任务" /> : null}
          {taskQuery.isError ? <ErrorState error={taskQuery.error} onRetry={taskQuery.refetch} /> : null}

          {editedTitles.length > 0 ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-3">
                <CardTitle as="h2">候选标题</CardTitle>
                <Field label="保存到商品" htmlFor="title-save-product" className="min-w-[12rem]">
                  <Select
                    id="title-save-product"
                    value={saveProductId ?? '__none__'}
                    onChange={(value) => setSaveProductId(value === '__none__' ? null : value)}
                    options={[{ value: '__none__', label: '选择商品' }, ...productOptions]}
                  />
                </Field>
              </CardHeader>
              <CardContent className="space-y-3">
                {editedTitles.map((title, index) => (
                  <div
                    key={index}
                    className="flex flex-col gap-2 rounded-lg border border-border-default bg-surface p-3 sm:flex-row sm:items-start sm:gap-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <Input
                        value={title}
                        onChange={(e) => {
                          const next = [...editedTitles];
                          next[index] = e.target.value;
                          setEditedTitles(next);
                        }}
                        aria-label={`候选标题 ${index + 1}`}
                      />
                      <p className="text-xs text-fg-subtle">{[...title.trim()].length} 字</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        iconLeft={<Copy size={14} />}
                        onClick={() => void copyToClipboard(title).then(() => toast.success('已复制'))}
                      >
                        复制
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        iconLeft={<Save size={14} />}
                        loading={saving}
                        onClick={() => void saveTitle(index)}
                      >
                        保存
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : task && isTerminalStatus(task.status) && task.status !== 'SUCCEEDED' ? (
            <InlineAlert tone="danger">{task.errorMessage ?? '标题生成失败'}</InlineAlert>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
