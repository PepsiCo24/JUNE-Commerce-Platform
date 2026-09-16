'use client';

import {
  ALLOWED_IMAGE_MIME_TYPES,
  POST_MAX_IMAGES,
  POST_TITLE_MAX,
  htmlToExcerpt,
  postPublishSchema,
  type AssetView,
  type PostDetail,
} from '@june/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Bold,
  Eye,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from 'lucide-react';
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
  } = props;

  const router = useRouter();
  const queryClient = useQueryClient();
  const images = usePostImages({ images: initialImages, coverAssetId: initialCoverAssetId });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const insertedIdsRef = useRef(new Set(initialImages.map((item) => item.id)));

  const [title, setTitle] = useState(initialTitle);
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
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: '写下你想分享的内容…' }),
    ],
    content: initialHtml || undefined,
    editorProps: {
      attributes: {
        class: 'june-prose min-h-80 outline-none',
      },
    },
    onUpdate: ({ editor: instance }) => onEditorUpdate(instance),
    onCreate: ({ editor: instance }) => onEditorUpdate(instance),
  });

  const snapshot: DraftSnapshot = useMemo(
    () => ({
      title,
      contentHtml: html,
      contentJson: json,
      coverAssetId: images.coverAssetId,
      imageAssetIds: images.imageAssetIds,
    }),
    [title, html, json, images.coverAssetId, images.imageAssetIds],
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

  const previewImages: PostDetail['images'] = images.images.map((asset) => ({
    assetId: asset.id,
    url: asset.url,
    previewUrl: asset.previewUrl ?? asset.url,
    width: asset.width,
    height: asset.height,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {mode === 'create' ? (
          <SaveStatus
            state={autosave.state}
            savedAt={autosave.savedAt}
            error={autosave.error}
            onRetry={autosave.retry}
          />
        ) : (
          <p className="text-xs text-fg-muted">编辑已发布内容不会自动保存,请确认后点击「更新」。</p>
        )}
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
            {mode === 'edit' ? '更新' : '发布'}
          </Button>
        </div>
      </div>

      {preview ? (
        <div className="rounded-lg border border-border-default bg-surface p-4 sm:p-6">
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
          <Field
            label="标题"
            htmlFor="post-title"
            required
            error={fieldErrors.title ?? fieldErrors['title'] ?? null}
            addon={<CharCounter value={title} max={POST_TITLE_MAX} />}
          >
            <Input
              id="post-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={POST_TITLE_MAX}
              placeholder="给这篇内容起个标题"
            />
          </Field>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-fg">正文</p>
              <p className="text-xs text-fg-subtle">最多 {POST_MAX_IMAGES} 张图片</p>
            </div>
            <EditorToolbar
              editor={editor}
              onAddImage={pickFiles}
              onAddLink={() => {
                const current = editor?.getAttributes('link')['href'];
                setLinkUrl(typeof current === 'string' && current.length > 0 ? current : 'https://');
                setLinkOpen(true);
              }}
            />
            {editor ? (
              <div
                className={cn(
                  'rounded-lg border border-border-default bg-surface px-3 py-3 sm:px-4',
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
              <p role="alert" className="text-xs text-state-danger-fg">
                {fieldErrors.contentHtml}
              </p>
            ) : null}
          </div>

          <ImageGallery images={images} onPick={pickFiles} />
          <UploadProgressList
            items={images.uploads}
            onRemove={images.removeUpload}
            onRetry={images.retryUpload}
          />
        </>
      )}

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

function EditorToolbar({
  editor,
  onAddImage,
  onAddLink,
}: {
  editor: Editor | null;
  onAddImage: () => void;
  onAddLink: () => void;
}): React.JSX.Element {
  const disabled = !editor;

  return (
    <div className="flex flex-wrap gap-1 rounded-md border border-border-default bg-bg-elevated p-1">
      <ToolbarButton
        label="加粗"
        active={editor?.isActive('bold') ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleBold().run()}
        icon={<Bold size={16} />}
      />
      <ToolbarButton
        label="斜体"
        active={editor?.isActive('italic') ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
        icon={<Italic size={16} />}
      />
      <ToolbarButton
        label="删除线"
        active={editor?.isActive('strike') ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleStrike().run()}
        icon={<Strikethrough size={16} />}
      />
      <ToolbarButton
        label="二级标题"
        active={editor?.isActive('heading', { level: 2 }) ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        icon={<Heading2 size={16} />}
      />
      <ToolbarButton
        label="三级标题"
        active={editor?.isActive('heading', { level: 3 }) ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
        icon={<Heading3 size={16} />}
      />
      <ToolbarButton
        label="无序列表"
        active={editor?.isActive('bulletList') ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
        icon={<List size={16} />}
      />
      <ToolbarButton
        label="有序列表"
        active={editor?.isActive('orderedList') ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        icon={<ListOrdered size={16} />}
      />
      <ToolbarButton
        label="引用"
        active={editor?.isActive('blockquote') ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        icon={<Quote size={16} />}
      />
      <ToolbarButton
        label="链接"
        active={editor?.isActive('link') ?? false}
        disabled={disabled}
        onClick={onAddLink}
        icon={<LinkIcon size={16} />}
      />
      <ToolbarButton label="插入图片" active={false} disabled={disabled} onClick={onAddImage} icon={<ImagePlus size={16} />} />
      <ToolbarButton
        label="撤销"
        active={false}
        disabled={disabled || !editor?.can().undo()}
        onClick={() => editor?.chain().focus().undo().run()}
        icon={<Undo2 size={16} />}
      />
      <ToolbarButton
        label="重做"
        active={false}
        disabled={disabled || !editor?.can().redo()}
        onClick={() => editor?.chain().focus().redo().run()}
        icon={<Redo2 size={16} />}
      />
    </div>
  );
}

function ToolbarButton({
  label,
  icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-sm text-fg-muted transition-colors',
        'hover:bg-surface-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-accent-surface text-accent',
      )}
    >
      {icon}
    </button>
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
