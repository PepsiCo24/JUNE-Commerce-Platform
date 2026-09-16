'use client';

import {
  ALLOWED_IMAGE_MIME_TYPES,
  POST_MAX_IMAGES,
  type AssetView,
} from '@june/shared';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { UploadItem } from '@/components/feedback/upload-progress';
import { uploadToSignedUrl } from '@/lib/api/client';
import { describeError } from '@/lib/api/errors';

import { confirmUpload, createUploadTicket } from '../api';

/**
 * 帖子图片上传。
 *
 * 真实三段式流程,没有任何伪造进度:
 *   1. POST /assets/upload-ticket 申请短时直传凭证(后端预检配额与类型);
 *   2. PUT 直传对象存储,进度来自 XHR 的 upload.progress —— 只有 lengthComputable
 *      时才有百分比,否则 percent 为 null,UI 显示阶段而不是编造的数字;
 *   3. POST /assets/:id/confirm 由后端回查实际内容后才置为可用。
 *
 * 命中同用户去重(deduplicated=true)时跳过第 2 步直接 confirm:
 * confirm 对已 ACTIVE 的资产是幂等的,会直接返回资产视图。
 */

/** 上传任务的原始文件,重试时要用 */
interface PendingFile {
  id: string;
  file: File;
}

export interface PostImagesController {
  images: AssetView[];
  uploads: UploadItem[];
  /** 已选中的封面资产 id */
  coverAssetId: string | null;
  setCoverAssetId: (assetId: string | null) => void;
  addFiles: (files: FileList | File[]) => void;
  removeImage: (assetId: string) => void;
  removeUpload: (id: string) => void;
  retryUpload: (id: string) => void;
  uploading: boolean;
  /** 供草稿/发布提交的资产 id 列表(顺序即插入顺序) */
  imageAssetIds: string[];
}

function newLocalId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 计算 sha256 用于同用户去重。不可用(非安全上下文)时返回 undefined,不影响上传。 */
async function sha256Hex(file: File): Promise<string | undefined> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return undefined;
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return undefined;
  }
}

export function usePostImages(initial: {
  images?: AssetView[];
  coverAssetId?: string | null;
}): PostImagesController {
  const [images, setImages] = useState<AssetView[]>(initial.images ?? []);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [coverAssetId, setCoverAssetId] = useState<string | null>(initial.coverAssetId ?? null);

  const pendingFilesRef = useRef(new Map<string, PendingFile>());
  const abortersRef = useRef(new Map<string, AbortController>());

  const patchUpload = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const runUpload = useCallback(
    async (localId: string, file: File) => {
      const controller = new AbortController();
      abortersRef.current.set(localId, controller);

      try {
        patchUpload(localId, { status: 'pending', percent: null, error: undefined });

        const sha256 = await sha256Hex(file);
        const ticket = await createUploadTicket({
          kind: 'POST_IMAGE',
          mimeType: file.type,
          byteSize: file.size,
          originalName: file.name,
          ...(sha256 ? { sha256 } : {}),
        });

        if (!ticket.deduplicated) {
          patchUpload(localId, { status: 'uploading', percent: null });
          await uploadToSignedUrl({
            url: ticket.uploadUrl,
            file,
            contentType: file.type,
            headers: ticket.headers,
            onProgress: (percent) => patchUpload(localId, { percent }),
            signal: controller.signal,
          });
        }

        patchUpload(localId, { status: 'confirming' });
        const asset = await confirmUpload(ticket.assetId);

        setImages((prev) => (prev.some((item) => item.id === asset.id) ? prev : [...prev, asset]));
        setCoverAssetId((prev) => prev ?? asset.id);
        patchUpload(localId, { status: 'done', percent: 100 });
        pendingFilesRef.current.delete(localId);

        // 成功项短暂保留后自动移出列表,避免面板越用越长
        window.setTimeout(() => {
          setUploads((prev) => prev.filter((item) => item.id !== localId));
        }, 2500);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setUploads((prev) => prev.filter((item) => item.id !== localId));
          return;
        }
        patchUpload(localId, { status: 'error', error: describeError(error) });
      } finally {
        abortersRef.current.delete(localId);
      }
    },
    [patchUpload],
  );

  const addFiles = useCallback(
    (input: FileList | File[]) => {
      const files = Array.from(input);
      if (files.length === 0) return;

      const accepted: File[] = [];
      for (const file of files) {
        if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
          toast.error(`${file.name}:仅支持 ${ALLOWED_IMAGE_MIME_TYPES.join('、')}`);
          continue;
        }
        accepted.push(file);
      }
      if (accepted.length === 0) return;

      // 已确认图片 + 正在上传的都算进配额,超过上限直接拒绝并说明还能加几张
      const inFlight = uploads.filter((item) => item.status !== 'error' && item.status !== 'done').length;
      const used = images.length + inFlight;
      const room = POST_MAX_IMAGES - used;

      if (room <= 0) {
        toast.error(`一篇帖子最多 ${POST_MAX_IMAGES} 张图片,请先删除部分图片`);
        return;
      }
      const queued = accepted.slice(0, room);
      if (queued.length < accepted.length) {
        toast.error(`一篇帖子最多 ${POST_MAX_IMAGES} 张图片,本次只接受 ${queued.length} 张`);
      }

      const entries = queued.map((file) => ({ localId: newLocalId(), file }));
      setUploads((prev) => [
        ...prev,
        ...entries.map(
          ({ localId, file }): UploadItem => ({
            id: localId,
            name: file.name,
            percent: null,
            status: 'pending',
          }),
        ),
      ]);

      for (const { localId, file } of entries) {
        pendingFilesRef.current.set(localId, { id: localId, file });
        void runUpload(localId, file);
      }
    },
    [images.length, runUpload, uploads],
  );

  const removeImage = useCallback((assetId: string) => {
    setImages((prev) => prev.filter((item) => item.id !== assetId));
    // 封面被删掉时清空选择,而不是悄悄换成另一张
    setCoverAssetId((prev) => (prev === assetId ? null : prev));
  }, []);

  const removeUpload = useCallback((id: string) => {
    abortersRef.current.get(id)?.abort();
    pendingFilesRef.current.delete(id);
    setUploads((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const retryUpload = useCallback(
    (id: string) => {
      const pending = pendingFilesRef.current.get(id);
      if (!pending) {
        toast.error('原文件已丢失,请重新选择图片');
        setUploads((prev) => prev.filter((item) => item.id !== id));
        return;
      }
      void runUpload(id, pending.file);
    },
    [runUpload],
  );

  return {
    images,
    uploads,
    coverAssetId,
    setCoverAssetId,
    addFiles,
    removeImage,
    removeUpload,
    retryUpload,
    uploading: uploads.some((item) => item.status === 'uploading' || item.status === 'confirming'),
    imageAssetIds: images.map((item) => item.id),
  };
}

/** 正文里插入图片时优先用 preview(体积小),派生图还没生成好时退回原图 */
export function assetDisplayUrl(asset: AssetView): string {
  return asset.previewUrl ?? asset.url;
}
