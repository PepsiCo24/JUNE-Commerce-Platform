'use client';

import {
  ALLOWED_IMAGE_MIME_TYPES,
  POST_CATEGORIES,
  POST_CATEGORY_DEFAULT,
  POST_CATEGORY_LABELS,
  POST_MAX_IMAGES,
  POST_TITLE_MAX,
  htmlToExcerpt,
  postPublishSchema,
  type AssetView,
  type PostCategory,
  type PostDetail,
} from '@june/shared';
import { useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { ArrowLeft, Eye, ImagePlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { SaveStatus } from '@/components/feedback/save-status';
import { LoadingState } from '@/components/feedback/states';
import { UploadProgressList } from '@/components/feedback/upload-progress';
import { AssetImage } from '@/components/media/asset-image';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { CharCounter, Field, Input } from '@/components/ui/input';
import { ApiError, describeError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

import { communityKeys, publishDraft, publishNewPost, updatePost } from '../api';
import { useDraftAutosave, type DraftSnapshot } from '../hooks/use-draft-autosave';
import { assetDisplayUrl, usePostImages } from '../hooks/use-post-images';
import { PostContent } from '../posts/post-content';
import { isEmptyPostContent, postDetailPath } from '../utils';
import { buildEditorExtensions, countEditorStats, EditorToolbar } from './editor-toolbar';

export type PostEditorMode = 'create' | 'edit';

export interface PostEditorProps {
  mode: PostEditorMode;
  /** 编辑已发布帖子时的帖子 id */
  postId?: string;
  /** 编辑已发布时用于跳转回详情 */
  slug?: string;
  initialDraftId?: string | null;
  initialRevision?: number;
  initialTitle?: string;
  initialHtml?: string;
  initialJson?: unknown;
  initialImages?: AssetView[];
  initialCoverAssetId?: string | null;
  initialCategory?: PostCategory;
}

/**
 * 帖子编辑器。
 *
 * - 新建:防抖自动保存草稿(第一次真正有内容时才 createDraft)
 * - 编辑已发布:关闭自动保存,提交走 updatePost,不会把改动悄悄写进线上内容
 */
export function PostEditor(props: PostEditorProps): React.JSX.Element {
  const {
    mode,
    postId,
    initialDraftId = null,
    initialRevision = 0,
    initialTitle = '',
    initialHtml = '',
    initialJson,
    initialImages = [],
    initialCoverAssetId = null,
    initialCategory = POST_CATEGORY_DEFAULT,
  } = props;

  const router = useRouter();
  const queryClient = useQueryClient();
  const images = usePostImages({ images: initialImages, coverAssetId: initialCoverAssetId });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const insertedIdsRef = useRef(new Set(initialImages.map((item) => item.id)));

  const [title, setTitle] = useState(initialTitle);
  const [category, setCategory] = useState<PostCategory>(initialCategory);
  const [html, setHtml] = useState(initialHtml);
  const [json, setJson] = useState<unknown>(initialJson ?? null);
  const [preview, setPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('https://');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const onEditorUpdate = useCallback((instance: Editor) => {
    setHtml(instance.getHTML());
    setJson(instance.getJSON());
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: buildEditorExtensions(),
    content: initialHtml || undefined,
    editorProps: {
      attributes: {
        class: 'june-prose june-editor-prose min-h-[480px] outline-none',
      },
      handleDOMEvents: {
        drop: (_view, event) => {
          const files = event.dataTransfer?.files;
          if (files && files.length > 0) {
            event.preventDefault();
            images.addFiles(files);
            return true;
          }
          return false;
        },
        paste: (_view, event) => {
          const files = event.clipboardData?.files;
          if (files && files.length > 0) {
            const imageFiles = [...files].filter((f) => f.type.startsWith('image/'));
            if (imageFiles.length > 0) {
              event.preventDefault();
              images.addFiles(imageFiles);
              return true;
            }
          }
          return false;
        },
      },
    },
    onUpdate: ({ editor: instance }) => onEditorUpdate(instance),
    onCreate: ({ editor: instance }) => onEditorUpdate(instance),
  });

  const stats = useMemo(() => countEditorStats(html), [html]);

  const snapshot: DraftSnapshot = useMemo(
    () => ({
      title,
      contentHtml: html,
      contentJson: json,
      coverAssetId: images.coverAssetId,
      imageAssetIds: images.imageAssetIds,
      category,
    }),
    [title, html, json, images.coverAssetId, images.imageAssetIds, category],
  );

  const hasContent =
    title.trim().length > 0 || !isEmptyPostContent(html) || images.imageAssetIds.length > 0;

  const autosave = useDraftAutosave({
    initialDraftId,
    initialRevision,
    snapshot,
    enabled: mode === 'create' && hasContent,
  });

  useEffect(() => {
    if (!editor) return;
    for (const asset of images.images) {
      if (insertedIdsRef.current.has(asset.id)) continue;
      insertedIdsRef.current.add(asset.id);
      editor
        .chain()
        .focus()
        .setImage({ src: assetDisplayUrl(asset), alt: '帖子图片' })
        .run();
    }
  }, [editor, images.images]);

  const pickFiles = (): void => fileInputRef.current?.click();

  const onFiles = (list: FileList | null): void => {
    if (!list || list.length === 0) return;
    images.addFiles(list);
  };

  const applyLink = (): void => {
    if (!editor) return;
    const trimmed = linkUrl.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run();
    }
    setLinkOpen(false);
  };

  const publish = async (): Promise<void> => {
    const parsed = postPublishSchema.safeParse({
      title,
      contentHtml: html,
      contentJson: json ?? undefined,
      excerpt: htmlToExcerpt(html),
      coverAssetId: images.coverAssetId,
      imageAssetIds: images.imageAssetIds,
      category,
    });
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join('.') || 'contentHtml';
        if (!(path in map)) map[path] = issue.message;
      }
      setFieldErrors(map);
      toast.error(parsed.error.issues[0]?.message ?? '还不能发布');
      return;
    }
    setFieldErrors({});

    if (images.uploading) {
      toast.info('还有图片正在上传,请等待完成后再发布');
      return;
    }

    setPublishing(true);
    try {
      let result: PostDetail;
      if (mode === 'edit') {
        if (!postId) throw new Error('缺少帖子编号');
        result = await updatePost(postId, parsed.data);
      } else if (autosave.draftId) {
        const saved = await autosave.saveNow();
        if (!saved) {
          toast.error(autosave.error ?? '草稿保存失败,请重试后再发布');
          return;
        }
        result = await publishDraft(autosave.draftId);
      } else {
        result = await publishNewPost(parsed.data);
      }

      toast.success(mode === 'edit' ? '已更新' : '已发布');
      void queryClient.invalidateQueries({ queryKey: communityKeys.all });
      router.push(postDetailPath(result.slug));
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      toast.error(describeError(error));
    } finally {
      setPublishing(false);
    }
  };

  const saveDraftNow = async (): Promise<void> => {
    if (mode !== 'create') return;
    const ok = await autosave.saveNow();
    if (ok) toast.success('草稿已保存');
    else toast.error(autosave.error ?? '草稿保存失败');
  };

  useEffect(() => {
    const onSaveDraft = (): void => {
      void saveDraftNow();
    };
    window.addEventListener('june:editor-save-draft', onSaveDraft);
    return () => window.removeEventListener('june:editor-save-draft', onSaveDraft);
  });

  const previewImages: PostDetail['images'] = images.images.map((asset) => ({
    assetId: asset.id,
    url: asset.url,
    previewUrl: asset.previewUrl ?? asset.url,
    width: asset.width,
    height: asset.height,
  }));

  const backHref = mode === 'edit' && props.slug ? postDetailPath(props.slug) : '/community';

  return (
    <div className="flex min-h-dvh flex-col bg-community-feed">
      {/* 与 AppShell 顶栏 (h-14) 对齐,避免 sticky 层叠遮挡导致按钮点不到 */}
      <div className="sticky top-14 z-40 border-b border-border-default bg-bg-elevated/95 backdrop-blur">
        <header>
          <div className="mx-auto flex max-w-[920px] flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
            <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
              <ArrowLeft size={16} aria-hidden />
              返回
            </Link>
            <div className="min-w-0 flex-1">
              {mode === 'create' ? (
                <SaveStatus
                  state={autosave.state}
                  savedAt={autosave.savedAt}
                  error={autosave.error}
                  onRetry={autosave.retry}
                />
              ) : (
                <p className="text-xs text-fg-muted">编辑已发布内容不会自动保存,请确认后点击「更新发布」。</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={preview ? 'primary' : 'outline'}
                size="sm"
                iconLeft={<Eye size={16} />}
                onClick={() => setPreview((value) => !value)}
              >
                {preview ? '继续编辑' : '预览'}
              </Button>
              {mode === 'create' ? (
                <Button variant="secondary" size="sm" onClick={() => void saveDraftNow()} disabled={!hasContent}>
                  存草稿
                </Button>
              ) : null}
              <Button
                size="sm"
                loading={publishing}
                onClick={() => void publish()}
                disabled={publishing || images.uploading}
              >
                {mode === 'edit' ? '更新发布' : '发布'}
              </Button>
            </div>
          </div>
        </header>
        {!preview ? (
          <div className="mx-auto max-w-[920px] px-4 pb-2 sm:px-6">
            <EditorToolbar
              editor={editor}
              onAddImage={pickFiles}
              onAddLink={() => {
                const current = editor?.getAttributes('link')['href'];
                setLinkUrl(typeof current === 'string' && current.length > 0 ? current : 'https://');
                setLinkOpen(true);
              }}
              className="static shadow-none"
            />
          </div>
        ) : null}
      </div>

      <div className="mx-auto w-full max-w-[920px] flex-1 px-4 py-4 sm:px-6 sm:py-6">
        {preview ? (
          <div className="june-editor-paper rounded-xl border border-border-default p-6 sm:p-10">
            <h2 className="text-2xl font-semibold text-fg">{title.trim() || '(无标题)'}</h2>
            <div className="mt-6">
              {isEmptyPostContent(html) ? (
                <p className="text-sm text-fg-muted">正文还是空的。</p>
              ) : (
                <PostContent contentHtml={html} images={previewImages} title={title || '预览'} />
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="june-editor-paper mx-auto max-w-[860px] rounded-xl border border-border-default shadow-sm">
              <div className="border-b border-border-default px-6 py-5 sm:px-12 sm:py-8">
                <input
                  id="post-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={POST_TITLE_MAX}
                  placeholder="文档标题"
                  className="w-full border-0 bg-transparent text-2xl font-semibold text-fg outline-none placeholder:text-fg-subtle sm:text-3xl"
                />
                {fieldErrors.title ? (
                  <p role="alert" className="mt-1 text-xs text-state-danger-fg">
                    {fieldErrors.title}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-fg-subtle">
                  <CharCounter value={title} max={POST_TITLE_MAX} />
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="帖子分类">
                  <span className="text-xs text-fg-muted">分类</span>
                  {POST_CATEGORIES.map((value) => {
                    const active = category === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setCategory(value)}
                        className={cn(
                          'rounded-full px-2.5 py-1 text-xs transition-colors',
                          active
                            ? 'bg-accent text-accent-fg'
                            : 'bg-surface-hover text-fg-muted hover:text-fg',
                        )}
                      >
                        {POST_CATEGORY_LABELS[value]}
                      </button>
                    );
                  })}
                </div>
                {fieldErrors.category ? (
                  <p role="alert" className="mt-1 text-xs text-state-danger-fg">
                    {fieldErrors.category}
                  </p>
                ) : null}
              </div>

              <div className="px-6 py-6 sm:px-12 sm:py-10">
                {editor ? (
                  <div
                    className={cn(
                      '[&_.is-editor-empty:first-child::before]:pointer-events-none',
                      '[&_.is-editor-empty:first-child::before]:float-left',
                      '[&_.is-editor-empty:first-child::before]:h-0',
                      '[&_.is-editor-empty:first-child::before]:text-fg-subtle',
                      '[&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]',
                    )}
                  >
                    <EditorContent editor={editor} />
                  </div>
                ) : (
                  <LoadingState message="正在加载编辑器" className="min-h-40" />
                )}
                {fieldErrors.contentHtml ? (
                  <p role="alert" className="mt-2 text-xs text-state-danger-fg">
                    {fieldErrors.contentHtml}
                  </p>
                ) : null}
              </div>

              <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border-default px-6 py-3 text-xs text-fg-subtle sm:px-12">
                <span>{stats.chars} 字 · 约 {stats.readingMinutes} 分钟阅读</span>
                <span>最多 {POST_MAX_IMAGES} 张图片</span>
              </footer>
            </div>

            <div className="mx-auto mt-6 max-w-[860px]">
              <ImageGallery images={images} onPick={pickFiles} />
              <UploadProgressList
                items={images.uploads}
                onRemove={images.removeUpload}
                onRetry={images.retryUpload}
              />
            </div>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
        multiple
        className="hidden"
        onChange={(event) => {
          onFiles(event.target.files);
          event.target.value = '';
        }}
      />

      <Dialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        title="插入链接"
        description="请输入完整网址。留空并确认可移除当前链接。"
        theme="light"
        footer={
          <>
            <Button variant="ghost" onClick={() => setLinkOpen(false)}>
              取消
            </Button>
            <Button onClick={applyLink}>确定</Button>
          </>
        }
      >
        <Field label="网址" htmlFor="post-link-url">
          <Input
            id="post-link-url"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            placeholder="https://"
            inputMode="url"
          />
        </Field>
      </Dialog>
    </div>
  );
}

function ImageGallery({
  images,
  onPick,
}: {
  images: ReturnType<typeof usePostImages>;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-fg">图片</p>
        <Button variant="outline" size="sm" iconLeft={<ImagePlus size={16} />} onClick={onPick}>
          添加图片
        </Button>
      </div>
      {images.images.length === 0 ? (
        <p className="text-sm text-fg-muted">还没有图片。上传后可设为封面,也会插入正文。</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {images.images.map((asset) => {
            const isCover = images.coverAssetId === asset.id;
            return (
              <li key={asset.id} className="flex flex-col gap-2">
                <AssetImage
                  asset={asset}
                  variant="thumb"
                  alt="帖子图片"
                  aspect="1/1"
                  className={cn('w-full overflow-hidden rounded-md', isCover && 'ring-2 ring-accent')}
                />
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant={isCover ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => images.setCoverAssetId(asset.id)}
                  >
                    {isCover ? '当前封面' : '设为封面'}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-state-danger-fg" onClick={() => images.removeImage(asset.id)}>
                    移除
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** 把详情接口的图片转成上传组件能用的 AssetView(缺省字段仅用于本地展示,不会提交给后端) */
export function postImagesToAssets(post: PostDetail): AssetView[] {
  return post.images.map((image) => ({
    id: image.assetId,
    kind: 'POST_IMAGE',
    status: 'ACTIVE',
    visibility: 'PUBLIC',
    mimeType: 'image/jpeg',
    byteSize: 1,
    width: image.width,
    height: image.height,
    url: image.url,
    thumbUrl: image.previewUrl,
    previewUrl: image.previewUrl,
    derivativeStatus: 'ready',
    createdAt: post.updatedAt,
  }));
}

/** 按封面 URL 对齐到图片资产;对不上就用第一张,绝不悄悄换成无关图片以外的猜测 */
export function inferCoverAssetId(post: PostDetail, assets: AssetView[]): string | null {
  if (!post.coverUrl) return assets[0]?.id ?? null;
  const matched = assets.find((asset) => {
    const candidates = [asset.url, asset.previewUrl, asset.thumbUrl].filter(
      (value): value is string => Boolean(value),
    );
    return candidates.some((candidate) => urlsLikelySame(candidate, post.coverUrl));
  });
  return matched?.id ?? assets[0]?.id ?? null;
}

function urlsLikelySame(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const strip = (value: string): string => {
    try {
      return decodeURIComponent(new URL(value, 'https://local.invalid').pathname).replace(
        /\.(thumb|preview)\.[a-z0-9]+$/i,
        '',
      );
    } catch {
      return value;
    }
  };
  return strip(left) === strip(right);
}
