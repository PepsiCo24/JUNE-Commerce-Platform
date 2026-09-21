'use client';

import {
  CONTENT_CHECK_DISCLAIMER,
  COPY_STYLES,
  ERROR_CODES,
  PROMPT_MAX,
  TARGET_PLATFORMS,
  copyGenerateSchema,
  type ContentCheckOutcome,
  type CopyGenerateInput,
  type CopyResultPayload,
  type CopySaveResponse,
  type TaskSubmitResponse,
} from '@june/shared';
import { Copy, History, PenLine, RefreshCw, Save } from 'lucide-react';
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
 * 文案生成:只保留提示词 / 模型 / 商品平台 / 生成。
 * 风格等参数用默认值;保存与预检在结果区完成。
 */
export function CopyStudio(): React.JSX.Element {
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
  const [checking, setChecking] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [editedBody, setEditedBody] = useState('');
  const [saveProductId, setSaveProductId] = useState<string | null>(null);
  const [saveCheck, setSaveCheck] = useState<ContentCheckOutcome | null>(null);

  const resolved = resolveActiveModel(modelConfig.data, 'text', selectedModelId);
  const model = blocked ? null : resolved.model;
  const locked = resolved.locked;
  const noModels = (modelConfig.data?.textModels.length ?? 0) === 0;
  const unverified = Boolean(model && !model.limits.verified);
  const defaultStyle = String(COPY_STYLES[0]?.value ?? 'professional');

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
  const resultText = useMemo(() => {
    const result = task?.results.find((item) => item.text && item.check?.passed);
    return result?.text ?? null;
  }, [task]);
  const blockedResults = useMemo(
    () => (task?.results ?? []).filter((item) => item.check && !item.check.passed),
    [task],
  );

  const hydratedKey = task?.id ?? '';
  const appliedTaskId = useRef('');
  useEffect(() => {
    if (!resultText || !hydratedKey || appliedTaskId.current === hydratedKey) return;
    appliedTaskId.current = hydratedKey;
    setEditedTitle(resultText.titles[0] ?? '');
    setEditedBody(resultText.body);
  }, [hydratedKey, resultText]);

  async function submit(): Promise<void> {
    if (noModels || !model) {
      toast.error('待真实联调：当前没有可用的文案模型');
      return;
    }
    if (!prompt.trim()) {
      setFieldErrors({ prompt: '请输入提示词' });
      return;
    }

    const body: CopyGenerateInput = {
      targetPlatform,
      style: defaultStyle,
      prompt: prompt.trim(),
      titleCount: 1,
      sellingPoints: [],
      idempotencyKey: key,
    };
    if (!locked && model.id) body.modelConfigId = model.id;

    const parsed = copyGenerateSchema.safeParse(body);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod(parsed.error));
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    setSaveCheck(null);
    try {
      const result = await api.post<TaskSubmitResponse>('/generation/copy', parsed.data);
      reset();
      const params = new URLSearchParams(searchParams.toString());
      params.set('taskId', result.taskId);
      router.replace(`/workbench/copy?${params.toString()}`, { scroll: false });
      toast.success(result.deduplicated ? '已复用相同请求的任务,不会重复计费' : '任务已提交');
    } catch (error) {
      if (isCode(error, ERROR_CODES.MODEL_SELECTION_LOCKED)) refreshModels();
      setFieldErrors(fieldErrorsFromApi(error));
      toast.error(
        describeSubmitError(
          error,
          modelConfig.data
            ? {
                running: modelConfig.data.concurrency.imagePerUserRunning,
                pending: modelConfig.data.concurrency.imagePerUserPending,
              }
            : undefined,
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function runCheck(): Promise<CopySaveResponse['check'] | null> {
    if (!saveProductId) {
      toast.error('请选择要保存到的商品');
      return null;
    }
    setChecking(true);
    try {
      const result = await api.post<{ check: CopySaveResponse['check']; disclaimer: string }>('/copy/check', {
        productId: saveProductId,
        title: editedTitle,
        body: editedBody,
        sourceTaskId: taskId,
      });
      setSaveCheck(result.check);
      if (!result.check.passed) toast.error('内容检查未通过,不能作为成功结果保存');
      else toast.success('内容检查已通过(不保证第三方平台审核通过)');
      return result.check;
    } catch (error) {
      toast.error(describeSubmitError(error));
      return null;
    } finally {
      setChecking(false);
    }
  }

  async function save(): Promise<void> {
    if (!saveProductId) {
      toast.error('请选择要保存到的商品');
      return;
    }
    setSaving(true);
    try {
      const result = await api.post<CopySaveResponse>('/copy/save', {
        productId: saveProductId,
        title: editedTitle,
        body: editedBody,
        sourceTaskId: taskId,
      });
      setSaveCheck(result.check);
      if (!result.saved) {
        toast.error('保存前检查未通过,内容未写入商品');
        return;
      }
      toast.success('已保存到商品。平台不保证第三方审核必定通过。');
    } catch (error) {
      toast.error(describeSubmitError(error));
    } finally {
      setSaving(false);
    }
  }

  const productOptions = (products.data ?? []).map((item) => ({
    value: item.id,
    label: item.sku ? `${item.name} (${item.sku})` : item.name,
    description: item.shopName,
  }));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <section className="space-y-4">
        <PageHeader
          title="文案生成"
          description="填写提示词,选择模型与商品平台后生成。"
          className="min-w-0"
          actions={
            <Button variant="ghost" size="sm" asChild className="shrink-0">
              <Link href="/workbench/copy/history">历史记录</Link>
            </Button>
          }
        />

        {modelConfig.isError ? <ErrorState error={modelConfig.error} onRetry={() => void modelConfig.refetch()} /> : null}
        {modelConfig.isPending ? <LoadingState message="加载模型配置" /> : null}
        {noModels ? (
          <EmptyState title="待配置文案模型" description="请在管理端配置并开放文案模型后使用。" />
        ) : null}
        {unverified ? (
          <InlineAlert tone="warning">当前模型尚未完成真实联调,请勿把结果当作已过审文案。</InlineAlert>
        ) : null}
        {blocked ? <InlineAlert tone="danger">所选模型已被停用,请重新选择。</InlineAlert> : null}

        {!noModels && !modelConfig.isPending && !modelConfig.isError ? (
          <>
            <Field
              label="提示词"
              htmlFor="copy-prompt"
              required
              error={fieldErrors.prompt ?? fieldErrors.productName}
              addon={<CharCounter value={prompt} max={PROMPT_MAX} />}
            >
              <Textarea
                id="copy-prompt"
                rows={5}
                autoGrow
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="描述商品、卖点、受众与文案要求"
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
                <Field label="模型" htmlFor="copy-model">
                  <Select
                    id="copy-model"
                    value={selectedModelId ?? model?.id ?? null}
                    onChange={(value) => {
                      setBlocked(false);
                      setSelectedModelId(value);
                    }}
                    options={resolved.options.map((item) => ({
                      value: item.id,
                      label: `${item.displayName}${item.isMock ? ' · 模拟' : ''}`,
                      description: item.limits.verified ? item.providerName : `${item.providerName} · 待真实联调`,
                    }))}
                    disabled={resolved.options.length <= 1}
                  />
                </Field>
              )}

              <Field label="商品平台" htmlFor="copy-platform">
                <Select
                  id="copy-platform"
                  value={targetPlatform}
                  onChange={setTargetPlatform}
                  options={TARGET_PLATFORMS.map((item) => ({ value: item.value, label: item.label }))}
                />
              </Field>
            </div>

            <Button
              fullWidth
              loading={submitting}
              disabled={noModels || !model || !prompt.trim()}
              iconLeft={<PenLine size={16} />}
              onClick={() => void submit()}
            >
              生成
            </Button>
          </>
        ) : null}
      </section>

      <section className="space-y-4 border-t border-border-default pt-6">
        {!taskId ? (
          <EmptyState icon={<PenLine size={22} />} title="等待提交" description="提交后会显示处理状态与检查结果。" />
        ) : taskQuery.isPending ? (
          <LoadingState message="加载任务" />
        ) : taskQuery.isError ? (
          <ErrorState error={taskQuery.error} onRetry={() => void taskQuery.refetch()} />
        ) : task ? (
          <>
            <TaskStatusBar task={task} degraded={degraded} />
            <InlineAlert tone="info">{CONTENT_CHECK_DISCLAIMER}</InlineAlert>

            {blockedResults.map((item) => (
              <CheckPanel key={item.id} check={item.check} title="未通过内容检查,不能作为成功结果展示" />
            ))}

            {task.results
              .filter((item) => item.status === 'FAILED')
              .map((item) => (
                <InlineAlert key={item.id} tone="danger">
                  {item.errorMessage ?? item.errorCode ?? '生成失败'}
                </InlineAlert>
              ))}

            {resultText ? (
              <CopyResultEditor
                text={resultText}
                title={editedTitle}
                body={editedBody}
                onTitleChange={setEditedTitle}
                onBodyChange={setEditedBody}
                productOptions={productOptions}
                saveProductId={saveProductId}
                onSaveProductChange={setSaveProductId}
                checking={checking}
                saving={saving}
                onCheck={() => void runCheck()}
                onSave={() => void save()}
                onRegenerate={() => void submit()}
                saveCheck={saveCheck}
              />
            ) : isTerminalStatus(task.status) && blockedResults.length === 0 && task.status !== 'SUCCEEDED' ? (
              <EmptyState title="没有可展示的文案" description="任务未产生通过检查的结果。" />
            ) : !isTerminalStatus(task.status) ? (
              <LoadingState message="正在生成并检查" />
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}

function CheckPanel({ check, title }: { check: ContentCheckOutcome | null; title: string }): React.JSX.Element | null {
  if (!check) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {check.violations.length === 0 ? (
          <p className="text-sm text-fg-muted">未列出具体命中项。</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {check.violations.map((item, index) => (
              <li key={`${item.ruleId}-${index}`} className="rounded-md border border-state-warning-border bg-state-warning-bg px-3 py-2">
                <p className="font-medium text-state-warning-fg">
                  {item.ruleName} · {item.field}
                </p>
                <p className="mt-1 text-xs text-fg-muted">命中片段：{item.matched}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CopyResultEditor({
  text,
  title,
  body,
  onTitleChange,
  onBodyChange,
  productOptions,
  saveProductId,
  onSaveProductChange,
  checking,
  saving,
  onCheck,
  onSave,
  onRegenerate,
  saveCheck,
}: {
  text: CopyResultPayload;
  title: string;
  body: string;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  productOptions: Array<{ value: string; label: string; description?: string }>;
  saveProductId: string | null;
  onSaveProductChange: (value: string) => void;
  checking: boolean;
  saving: boolean;
  onCheck: () => void;
  onSave: () => void;
  onRegenerate: () => void;
  saveCheck: ContentCheckOutcome | null;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle as="h2">标题</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {text.titles.length > 1 ? (
            <ul className="space-y-2">
              {text.titles.map((item) => (
                <li key={item} className="flex items-start justify-between gap-2 rounded-md border border-border-default px-3 py-2">
                  <button type="button" className="min-w-0 flex-1 text-left text-sm text-fg" onClick={() => onTitleChange(item)}>
                    {item}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="复制标题"
                    onClick={() => void copyToClipboard(item).then((ok) => toast.success(ok ? '已复制标题' : '复制失败'))}
                  >
                    <Copy size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <Field label="当前标题" htmlFor="edit-title">
            <Input id="edit-title" value={title} onChange={(event) => onTitleChange(event.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle as="h2">正文</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Copy size={14} />}
            onClick={() => void copyToClipboard(body).then((ok) => toast.success(ok ? '已复制正文' : '复制失败'))}
          >
            复制
          </Button>
        </CardHeader>
        <CardContent>
          <Textarea id="edit-body" rows={10} autoGrow value={body} onChange={(event) => onBodyChange(event.target.value)} />
        </CardContent>
      </Card>

      {text.highlights.length > 0 ? (
        <p className="text-sm text-fg-muted">提炼卖点：{text.highlights.join('、')}</p>
      ) : null}

      {saveCheck && !saveCheck.passed ? <CheckPanel check={saveCheck} title="保存前检查未通过" /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="保存到商品" htmlFor="save-copy-product" required>
          <Select
            id="save-copy-product"
            value={saveProductId}
            onChange={onSaveProductChange}
            options={productOptions}
            placeholder="选择商品"
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={checking} onClick={onCheck}>
          预检
        </Button>
        <Button loading={saving} iconLeft={<Save size={16} />} onClick={onSave}>
          保存到商品
        </Button>
        <Button variant="outline" iconLeft={<RefreshCw size={16} />} onClick={onRegenerate}>
          重新生成
        </Button>
        <Button variant="ghost" iconLeft={<History size={16} />} asChild>
          <Link href="/workbench/copy/history">查看历史</Link>
        </Button>
      </div>
    </div>
  );
}
