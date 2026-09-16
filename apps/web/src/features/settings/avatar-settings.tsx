'use client';

import { updateProfileSchema, type SessionUser } from '@june/shared';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { confirmUpload, createUploadTicket } from '@/features/community/api';
import { api, uploadToSignedUrl } from '@/lib/api/client';
import { describeError } from '@/lib/api/errors';
import { useAuth } from '@/providers/auth-provider';

/** 简单正方形裁剪:取居中区域 */
async function cropSquare(file: File, size = 512): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('裁剪失败'))), file.type || 'image/jpeg', 0.92);
  });
  return new File([blob], file.name, { type: blob.type });
}

export function AvatarSettings(): React.JSX.Element {
  const { user, patchUser, refresh } = useAuth();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const onFile = async (list: FileList | null): Promise<void> => {
    const file = list?.[0];
    if (!file || !user) return;
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('图片不能超过 5MB');
      return;
    }

    setUploading(true);
    try {
      const cropped = await cropSquare(file);
      const ticket = await createUploadTicket({
        kind: 'AVATAR',
        mimeType: cropped.type,
        byteSize: cropped.size,
        originalName: cropped.name,
      });
      if (!ticket.deduplicated) {
        await uploadToSignedUrl({
          url: ticket.uploadUrl,
          file: cropped,
          contentType: cropped.type,
          headers: ticket.headers,
        });
      }
      const asset = await confirmUpload(ticket.assetId);
      const next = await api.patch<SessionUser>('/auth/profile', {
        avatarAssetId: asset.id,
      });
      patchUser(next);
      await refresh();
      toast.success('头像已更新');
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const clearAvatar = async (): Promise<void> => {
    setUploading(true);
    try {
      const parsed = updateProfileSchema.safeParse({ avatarAssetId: null });
      if (!parsed.success) return;
      const next = await api.patch<SessionUser>('/auth/profile', parsed.data);
      patchUser(next);
      await refresh();
      toast.success('已恢复默认头像');
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setUploading(false);
    }
  };

  if (!user) return <p className="text-sm text-fg-muted">请先登录。</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <Avatar src={user.avatarUrl} name={user.displayName} size={96} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" loading={uploading} onClick={() => inputRef.current?.click()}>
            上传新头像
          </Button>
          <Button variant="ghost" disabled={uploading || !user.avatarUrl} onClick={() => void clearAvatar()}>
            恢复默认
          </Button>
        </div>
      </div>
      <p className="text-sm text-fg-muted">
        支持 JPG、PNG、WebP,最大 5MB。上传后自动居中裁剪为正方形,全站同步更新。
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => void onFile(e.target.files)}
      />
    </div>
  );
}
