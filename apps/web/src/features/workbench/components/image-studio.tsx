'use client';

import {
  ALLOWED_IMAGE_MIME_TYPES,
  ERROR_CODES,
  IMAGE_COUNT_MAX,
  IMAGE_COUNT_MIN,
  NEGATIVE_PROMPT_MAX,
  PROMPT_MAX,
  imageGenerateSchema,
  type AssetView,
  type ImageGenerateInput,
  type PublicModelOption,
  type TaskSubmitResponse,
  validateImageParamsAgainstLimits,
} from '@june/shared';
import { ImagePlus, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/states';
import { UploadProgressList } from '@/components/feedback/upload-progress';
import { PageHeader } from '@/components/layout/page-header';
import { AssetImage } from '@/components/media/asset-image';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CharCounter, Field, Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { api } from '@/lib/api/client';

import { useAssetUpload } from '../hooks/use-asset-upload';
import { useIdempotencyKey } from '../hooks/use-idempotency-key';
import {
  limitsOf,
  resolveActiveModel,
  useDisabledModelGuard,
  useModelConfig,
  useRefreshModelConfig,
} from '../hooks/use-model-config';
import { isCode } from '../lib/error-copy';
import { describeSubmitError, fieldErrorsFromApi, fieldErrorsFromZod } from '../lib/form';

import { ImageResultPanel } from './generation-results';
import { InlineAlert } from './inline-alert';

export function ImageStudio(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const taskId = searchParams.get('taskId');

  const modelConfig = useModelConfig();
  const refreshModels = useRefreshModelConfig();
  const upload = useAssetUpload();

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [count, setCount] = useState(1);
  const [size, setSize] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<string | null>(null);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [seed, setSeed] = useState('');
  const [references, setReferences] = useState<AssetView[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);

  const resolved = resolveActiveModel(modelConfig.data, 'image', selectedModelId);
  const model = blocked ? null : resolved.model;
  const locked = resolved.locked;
  const limits = limitsOf(model);

  useDisabledModelGuard(model?.id ?? selectedModelId, () => {
    setSelectedModelId(null);
    setBlocked(true);
    toast.error('所选模型已被停用,请重新选择');
  });

  const signature = JSON.stringify({
    prompt,
    negativePrompt,
    count,
    size,
    aspectRatio,
    width,
    height,
    seed,
    refs: references.map((item) => item.id),
    model: locked ? null : selectedModelId,
  });
  const { key, reset } = useIdempotencyKey(signature);

  const maxCount = Math.min(IMAGE_COUNT_MAX, limits.maxOutputs);
  const maxRefs = limits.maxReferenceImages;
  const promptMax = limits.maxPromptChars > 0 ? Math.min(limits.maxPromptChars, PROMPT_MAX) : PROMPT_MAX;
  const noModels = modelConfig.data ? modelConfig.data.imageModels.length === 0 : false;
  const unverified = Boolean(model && !model.limits.verified);

  const bindTask = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('taskId', id);
      router.replace(`/workbench/image?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  function applySizeDefaults(next: PublicModelOption | null): void {
    if (!next) return;
    const nextLimits = limitsOf(next);
    if (nextLimits.sizeMode === 'size_string' && nextLimits.sizes[0]) setSize(nextLimits.sizes[0]);
    if (nextLimits.sizeMode === 'aspect_ratio' && nextLimits.aspectRatios[0]) setAspectRatio(nextLimits.aspectRatios[0]);
    if (nextLimits.sizeMode === 'width_height') {
      setWidth(nextLimits.minWidth ?? 1024);
      setHeight(nextLimits.minHeight ?? 1024);
    }
  }

  if (model && limits.sizeMode === 'size_string' && !size && limits.sizes[0]) {
    setSize(limits.sizes[0]);
  }
  if (model && limits.sizeMode === 'aspect_ratio' && !aspectRatio && limits.aspectRatios[0]) {
    setAspectRatio(limits.aspectRatios[0]);
  }

  async function onPickFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const remain = Math.max(0, maxRefs - references.length);
    const picked = Array.from(files).slice(0, remain);
    const invalid = picked.filter((file) => !(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type));
    if (invalid.length > 0) {
      toast.error('仅支持 JPEG / PNG / WebP / GIF / AVIF');
      return;
    }
    const assets = await upload.upload(picked, 'REFERENCE_IMAGE');
    setReferences((prev) => [...prev, ...assets].slice(0, maxRefs));
  }

  async function submit(): Promise<void> {
    if (noModels || !model) {
      toast.error('待真实联调：当前没有可用的生图模型');
      return;
    }

    const issues = validateImageParamsAgainstLimits(
      {
        count,
        size,
        aspectRatio,
        width,
        height,
        referenceCount: references.length,
        negativePrompt: negativePrompt || null,
        prompt,
      },
      limits,
    );
    if (issues.length > 0) {
      const map: Record<string, string> = {};
      for (const issue of issues) {
        if (!(issue.path in map)) map[issue.path] = issue.message;
      }
      setFieldErrors(map);
      return;
    }

    const body: ImageGenerateInput = {
      prompt,
      count,
      referenceAssetIds: references.map((item) => item.id),
      idempotencyKey: key,
    };
    if (!locked && model.id) body.modelConfigId = model.id;
    if (limits.supportsNegativePrompt) body.negativePrompt = negativePrompt || null;
    if (limits.sizeMode === 'size_string') body.size = size;
    if (limits.sizeMode === 'aspect_ratio') body.aspectRatio = aspectRatio;
    if (limits.sizeMode === 'width_height') {
      body.width = width;
      body.height = height;
    }
    if (limits.supportsSeed && seed) body.seed = Number(seed);

    const parsed = imageGenerateSchema.safeParse(body);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod(parsed.error));
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    try {
      const result = await api.post<TaskSubmitResponse>('/generation/image', parsed.data);
      reset();
      setQueuePosition(result.queuePosition);
      bindTask(result.taskId);
      toast.success(result.deduplicated ? '已复用相同请求的任务,不会重复计费' : '任务已提交');
    } catch (error) {
      if (isCode(error, ERROR_CODES.MODEL_SELECTION_LOCKED)) refreshModels();
      setFieldErrors(fieldErrorsFromApi(error));
      toast.error(describeSubmitError(
        error,
        modelConfig.data
          ? { running: modelConfig.data.concurrency.imagePerUserRunning, pending: modelConfig.data.concurrency.imagePerUserPending }
          : undefined,
      ));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <section className="space-y-4">
        <PageHeader
          title="AI 生图"
          description="上方填写参考图与提示词,下方查看生成结果。"
          className="min-w-0"
          actions={
            <Button variant="ghost" size="sm" asChild className="shrink-0">
              <Link href="/workbench/image/history">历史记录</Link>
            </Button>
          }
        />

        {modelConfig.isError ? <ErrorState error={modelConfig.error} onRetry={() => void modelConfig.refetch()} /> : null}
        {modelConfig.isPending ? <LoadingState message="加载模型配置" /> : null}

        {noModels ? (
          <EmptyState
            icon={<ImagePlus size={22} />}
            title="待配置生图模型"
            description="当前没有可用的生图模型,无法提交。不会假装生成成功。"
          />
        ) : null}

        {unverified ? (
          <InlineAlert tone="warning">当前模型尚未完成真实联调,结果仅供联调验证,请勿当作正式产出。</InlineAlert>
        ) : null}
        {blocked ? (
          <InlineAlert tone="danger">所选模型已被停用。请重新选择,系统不会自动切换到其他供应商。</InlineAlert>
        ) : null}

        {!noModels && !modelConfig.isPending && !modelConfig.isError ? (
          <>
            {locked && model ? (
              <p className="flex items-center gap-2 text-sm text-fg-muted">
                当前模型 {model.displayName}
                {model.isMock ? (
                  <Badge tone="warning" size="sm">
                    模拟
                  </Badge>
                ) : null}
              </p>
            ) : null}

            {!locked && resolved.options.length > 1 ? (
              <Field label="模型" htmlFor="image-model">
                <Select
                  id="image-model"
                  value={selectedModelId ?? model?.id ?? null}
                  onChange={(value) => {
                    setBlocked(false);
                    setSelectedModelId(value);
                    const next = resolved.options.find((item) => item.id === value) ?? null;
                    applySizeDefaults(next);
                  }}
                  options={resolved.options.map((item) => ({
                    value: item.id,
                    label: (
                      <span className="inline-flex items-center gap-2">
                        {item.displayName}
                        {item.isMock ? ' · 模拟' : ''}
                      </span>
                    ),
                    description: `${item.providerName}${item.limits.verified ? '' : ' · 待真实联调'}`,
                  }))}
                />
              </Field>
            ) : null}

            {model?.isMock && !locked ? (
              <Badge tone="warning" size="sm">
                模拟供应商,不假装真实生成
              </Badge>
            ) : null}

            {maxRefs > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle as="h2">参考图</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {references.map((asset) => (
                      <div key={asset.id} className="relative size-20 overflow-hidden rounded-md border border-border-default">
                        <AssetImage asset={asset} variant="thumb" alt="参考图" aspect="1/1" className="size-full" />
                        <Button
                          variant="danger"
                          size="icon"
                          className="absolute right-1 top-1 size-6"
                          aria-label="移除参考图"
                          onClick={() => setReferences((prev) => prev.filter((item) => item.id !== asset.id))}
                        >
                          <X size={12} />
                        </Button>
                      </div>
                    ))}
                    {references.length < maxRefs ? (
                      <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border-strong text-fg-muted hover:bg-surface-hover">
                        <Upload size={16} aria-hidden />
                        <span className="text-[11px]">上传</span>
                        <input
                          type="file"
                          accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
                          multiple
                          className="sr-only"
                          onChange={(event) => {
                            void onPickFiles(event.target.files);
                            event.target.value = '';
                          }}
                        />
                      </label>
                    ) : null}
                  </div>
                  <p className="text-xs text-fg-subtle">最多 {maxRefs} 张。可预览后删除再重新上传。</p>
                  <UploadProgressList items={upload.items} onRemove={upload.removeItem} onRetry={upload.retryItem} />
                  {fieldErrors.referenceAssetIds ? (
                    <p className="text-xs text-state-danger-fg">{fieldErrors.referenceAssetIds}</p>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <Field label="提示词" htmlFor="image-prompt" required error={fieldErrors.prompt} addon={<CharCounter value={prompt} max={promptMax} />}>
              <Textarea
                id="image-prompt"
                value={prompt}
                autoGrow
                rows={5}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="描述商品图的主体、场景、光线与风格"
              />
            </Field>

            {limits.supportsNegativePrompt ? (
              <Field
                label="负向提示词"
                htmlFor="image-negative"
                error={fieldErrors.negativePrompt}
                addon={<CharCounter value={negativePrompt} max={NEGATIVE_PROMPT_MAX} />}
              >
                <Textarea
                  id="image-negative"
                  value={negativePrompt}
                  rows={2}
                  onChange={(event) => setNegativePrompt(event.target.value)}
                />
              </Field>
            ) : null}

            <Field label={`数量 ${count}`} htmlFor="image-count" error={fieldErrors.count}>
              <Slider
                id="image-count"
                min={IMAGE_COUNT_MIN}
                max={maxCount}
                value={count}
                onChange={setCount}
                aria-label="生成数量"
              />
            </Field>

            {limits.sizeMode === 'size_string' && limits.sizes.length > 0 ? (
              <Field label="尺寸" htmlFor="image-size" error={fieldErrors.size}>
                <Select
                  id="image-size"
                  value={size}
                  onChange={setSize}
                  options={limits.sizes.map((item) => ({ value: item, label: item }))}
                />
              </Field>
            ) : null}

            {limits.sizeMode === 'aspect_ratio' && limits.aspectRatios.length > 0 ? (
              <Field label="比例" htmlFor="image-ratio" error={fieldErrors.aspectRatio}>
                <Select
                  id="image-ratio"
                  value={aspectRatio}
                  onChange={setAspectRatio}
                  options={limits.aspectRatios.map((item) => ({ value: item, label: item }))}
                />
              </Field>
            ) : null}

            {limits.sizeMode === 'width_height' ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="宽度" htmlFor="image-width" error={fieldErrors.width}>
                  <Input
                    id="image-width"
                    type="number"
                    value={width}
                    min={limits.minWidth}
                    max={limits.maxWidth}
                    step={limits.dimensionStep}
                    onChange={(event) => setWidth(Number(event.target.value))}
                  />
                </Field>
                <Field label="高度" htmlFor="image-height" error={fieldErrors.height}>
                  <Input
                    id="image-height"
                    type="number"
                    value={height}
                    min={limits.minHeight}
                    max={limits.maxHeight}
                    step={limits.dimensionStep}
                    onChange={(event) => setHeight(Number(event.target.value))}
                  />
                </Field>
              </div>
            ) : null}

            {limits.supportsSeed ? (
              <Field label="随机种子" htmlFor="image-seed" description="留空则由模型随机">
                <Input id="image-seed" inputMode="numeric" value={seed} onChange={(event) => setSeed(event.target.value)} />
              </Field>
            ) : null}

            <Button
              fullWidth
              loading={submitting || upload.uploading}
              disabled={noModels || !model || !prompt.trim()}
              iconLeft={<ImagePlus size={16} />}
              onClick={() => void submit()}
            >
              开始生成
            </Button>
          </>
        ) : null}
      </section>

      <section className="space-y-4 border-t border-border-default pt-6">
        <ImageResultPanel taskId={taskId} queuePosition={queuePosition} />
      </section>
    </div>
  );
}
