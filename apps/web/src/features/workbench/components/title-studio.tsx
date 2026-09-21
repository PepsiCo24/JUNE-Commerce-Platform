'use client';

import {
  ERROR_CODES,
  PROMPT_MAX,
  TARGET_PLATFORMS,
  titleGenerateSchema,
  type TaskSubmitResponse,
  type TitleGenerateInput,
  type TitleSaveResponse,
} from '@june/shared';
import { Copy, PenLine, Save } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CharCounter, Field, Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api/client';
import { copyToClipboard } from '@/lib/utils';

import { useIdempotencyKey } from '../hooks/use-idempotency-key';
import { resolveActiveModel, useDisabledModelGuard, useModelConfig, useRefreshModelConfig } from '../hooks/use-model-config';
import { useProductOptions } from '../hooks/use-options';
import { isTerminalStatus, useTaskDetail } from '../hooks/use-task-detail';
import { isCode } from '../lib/error-copy';
import { describeSubmitError, fieldErrorsFromApi, fieldErrorsFromZod } from '../lib/form';

import { InlineAlert } from './inline-alert';
import { TaskStatusBar } from './task-status-bar';

/**
 * 标题生成:只保留提示词 / 模型 / 商品平台 / 生成。
 * 候选数量与字数上限用默认值;保存到商品在结果区完成。
 */
export function TitleStudio(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const taskId = searchParams.get('taskId');

  const modelConfig = useModelConfig();
  const refreshModels = useRefreshModelConfig();
  const { query: taskQuery, degraded } = useTaskDetail(taskId);
  const products = useProductOptions();

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [targetPlatform, setTargetPlatform] = useState(String(TARGET_PLATFORMS[0]?.value ?? 'other'));
  const [prompt, setPrompt] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedTitles, setEditedTitles] = useState<string[]>([]);
  const [saveProductId, setSaveProductId] = useState<string | null>(null);
  const resultsRef = useRef<HTMLElement>(null);

  const resolved = resolveActiveModel(modelConfig.data, 'title', selectedModelId);
  const model = blocked ? null : resolved.model;
  const locked = resolved.locked;
  const noModels = (modelConfig.data?.titleModels.length ?? 0) === 0;
  const unverified = Boolean(model && !model.limits.verified);

  useDisabledModelGuard(model?.id ?? selectedModelId, () => {
    setSelectedModelId(null);
    setBlocked(true);
    toast.error('所选模型已被停用,请重新选择');
  });

  const signature = JSON.stringify({
    targetPlatform,
    prompt,
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
  }, [hydratedKey, titleResult]);

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
    if (!prompt.trim()) {
      setFieldErrors({ prompt: '请输入提示词' });
      return;
    }

    const body: TitleGenerateInput = {
      targetPlatform,
      prompt: prompt.trim(),
      titleCount: 5,
      maxTitleLength: 60,
      sellingPoints: [],
      keywords: [],
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

  const productOptions = (products.data ?? []).map((item) => ({
    value: item.id,
    label: item.sku ? `${item.name} (${item.sku})` : item.name,
  }));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <section className="space-y-4">
        <PageHeader
          title="标题生成"
          description="填写提示词,选择模型与商品平台后生成。"
          className="min-w-0"
          actions={
            <Button variant="ghost" size="sm" asChild className="shrink-0">
              <Link href="/workbench/title/history">历史记录</Link>
            </Button>
          }
        />

        {modelConfig.isError ? <ErrorState error={modelConfig.error} onRetry={() => void modelConfig.refetch()} /> : null}
        {modelConfig.isPending ? <LoadingState message="加载模型配置" /> : null}
        {noModels ? (
          <EmptyState title="待配置标题模型" description="请在管理端配置并开放标题模型后使用。" />
        ) : null}
        {unverified ? <InlineAlert tone="warning">当前模型尚未完成真实联调,结果仅供验证。</InlineAlert> : null}
        {blocked ? <InlineAlert tone="danger">所选模型已被停用,请重新选择。</InlineAlert> : null}

        {!noModels && !modelConfig.isPending && !modelConfig.isError ? (
          <>
            <Field
              label="提示词"
              htmlFor="title-prompt"
              required
              error={fieldErrors.prompt ?? fieldErrors.productName}
              addon={<CharCounter value={prompt} max={PROMPT_MAX} />}
            >
              <Textarea
                id="title-prompt"
                rows={5}
                autoGrow
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                maxLength={PROMPT_MAX}
                placeholder="描述商品名称、卖点、风格与关键词要求"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              {locked && model ? (
                <div className="flex items-end pb-2 text-sm text-fg-muted">
                  模型 {model.displayName}
                  {model.isMock ? (
                    <Badge tone="warning" size="sm" className="ml-2">
                      模拟
                    </Badge>
                  ) : null}
                </div>
              ) : (
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
                      description: `${item.providerName}${item.limits.verified ? '' : ' · 待真实联调'}`,
                    }))}
                    disabled={resolved.options.length <= 1}
                  />
                </Field>
              )}

              <Field label="商品平台" htmlFor="title-platform">
                <Select
                  id="title-platform"
                  value={targetPlatform}
                  onChange={setTargetPlatform}
                  options={TARGET_PLATFORMS.map((p) => ({ value: p.value, label: p.label }))}
                />
              </Field>
            </div>

            <Button
              fullWidth
              loading={submitting}
              onClick={() => void submit()}
              disabled={noModels || !model || !prompt.trim()}
              iconLeft={<PenLine size={16} />}
            >
              生成
            </Button>
          </>
        ) : null}
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
