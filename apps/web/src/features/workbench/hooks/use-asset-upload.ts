'use client';

import type { AssetView, UploadTicketRequest, UploadTicketResponse } from '@june/shared';
import { useCallback, useRef, useState } from 'react';

import type { UploadItem } from '@/components/feedback/upload-progress';
import { api, uploadToSignedUrl } from '@/lib/api/client';
import { describeError } from '@/lib/api/errors';

/**
 * 真实上传流程:upload-ticket → 直传对象存储 → confirm。
 *
 * 三步各自的意义:
 *  1. upload-ticket:后端预检配额与类型并签发短时 PUT 地址;命中同用户去重时直接复用已有资产,
 *     此时跳过上传(省流量也省配额);
 *  2. 直传:走 XHR 才有 upload.progress 事件,进度是真实的字节进度,
 *     `lengthComputable` 为 false 时 percent 保持 null,只显示阶段,不编造百分比;
 *  3. confirm:后端回查对象存储实际内容/大小/类型后才把资产置为可用 —— 前端声明不算数。
 */

let uploadSeq = 0;
function nextUploadId(): string {
  uploadSeq += 1;
  return `upload-${uploadSeq}-${Date.now().toString(36)}`;
}

export interface UseAssetUploadResult {
  /** 传给 <UploadProgressList /> 的进度条目 */
  items: UploadItem[];
  uploading: boolean;
  /** 上传一批文件,返回成功的资产(顺序与入参一致,失败项被剔除) */
  upload: (files: File[], kind: UploadTicketRequest['kind']) => Promise<AssetView[]>;
  removeItem: (id: string) => void;
  clearFinished: () => void;
  /** 重试某个失败项 */
  retryItem: (id: string) => void;
}

export function useAssetUpload(): UseAssetUploadResult {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  /** 失败项的重试入口:保存原始 File 与用途,重试时不需要用户重新选文件 */
  const retryablesRef = useRef(new Map<string, { file: File; kind: UploadTicketRequest['kind'] }>());

  const patch = useCallback((id: string, next: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...next } : item)));
  }, []);

  const uploadOne = useCallback(
    async (id: string, file: File, kind: UploadTicketRequest['kind']): Promise<AssetView | null> => {
      try {
        patch(id, { status: 'uploading', percent: null, error: undefined });

        const ticket = await api.post<UploadTicketResponse>('/assets/upload-ticket', {
          kind,
          mimeType: file.type,
          byteSize: file.size,
          originalName: file.name,
        } satisfies UploadTicketRequest);

        if (!ticket.deduplicated) {
          await uploadToSignedUrl({
            url: ticket.uploadUrl,
            file,
            contentType: file.type,
            headers: ticket.headers,
            onProgress: (percent) => patch(id, { percent }),
          });
        } else {
          // 命中去重:没有真实字节传输,直接进入确认阶段
          patch(id, { percent: 100 });
        }

        patch(id, { status: 'confirming', percent: 100 });
        const asset = await api.post<AssetView>(`/assets/${ticket.assetId}/confirm`);

        patch(id, { status: 'done', percent: 100 });
        retryablesRef.current.delete(id);
        return asset;
      } catch (error) {
        patch(id, { status: 'error', percent: null, error: describeError(error) });
        retryablesRef.current.set(id, { file, kind });
        return null;
      }
    },
    [patch],
  );

  const upload = useCallback(
    async (files: File[], kind: UploadTicketRequest['kind']): Promise<AssetView[]> => {
      if (files.length === 0) return [];

      const entries = files.map((file) => ({ id: nextUploadId(), file }));
      setItems((prev) => [
        ...prev,
        ...entries.map<UploadItem>(({ id, file }) => ({
          id,
          name: file.name,
          percent: null,
          status: 'pending',
        })),
      ]);

      setUploading(true);
      try {
        // 串行上传:并行会抢占上行带宽,进度条互相拖慢,用户更难判断还要等多久
        const assets: AssetView[] = [];
        for (const entry of entries) {
          const asset = await uploadOne(entry.id, entry.file, kind);
          if (asset) assets.push(asset);
        }
        return assets;
      } finally {
        setUploading(false);
      }
    },
    [uploadOne],
  );

  const removeItem = useCallback((id: string) => {
    retryablesRef.current.delete(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((item) => item.status !== 'done'));
  }, []);

  const retryItem = useCallback(
    (id: string) => {
      const pending = retryablesRef.current.get(id);
      if (!pending) return;
      setUploading(true);
      void uploadOne(id, pending.file, pending.kind).finally(() => setUploading(false));
    },
    [uploadOne],
  );

  return { items, uploading, upload, removeItem, clearFinished, retryItem };
}
