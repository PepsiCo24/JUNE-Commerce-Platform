'use client';

import { ChevronLeft, ChevronRight, Download, ImageOff, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

function triggerDownload(url: string, fileName?: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  if (fileName) anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

export interface AssetImageSource {
  id: string;
  url: string;
  thumbUrl?: string | null;
  previewUrl?: string | null;
  width?: number | null;
  height?: number | null;
  mimeType?: string;
}

function pickSrc(asset: AssetImageSource, variant: 'thumb' | 'preview' | 'original'): string {
  if (variant === 'thumb') return asset.thumbUrl || asset.previewUrl || asset.url;
  if (variant === 'preview') return asset.previewUrl || asset.url;
  return asset.url;
}

export function AssetImage({
  asset,
  variant = 'preview',
  alt,
  aspect,
  className,
  sizes,
  priority = false,
  onClick,
}: {
  asset: AssetImageSource | null;
  variant?: 'thumb' | 'preview' | 'original';
  alt: string;
  aspect?: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);

  if (!asset || failed) {
    return (
      <div
        className={cn('flex items-center justify-center bg-bg-elevated text-fg-subtle', className)}
        style={aspect ? { aspectRatio: aspect.replace('/', ' / ') } : undefined}
        aria-label={alt}
      >
        <ImageOff size={24} aria-hidden />
      </div>
    );
  }

  const width = asset.width ?? undefined;
  const height = asset.height ?? undefined;
  const ratio = aspect ?? (width && height ? `${width} / ${height}` : '4 / 3');

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn('relative block overflow-hidden bg-bg-elevated', onClick && 'cursor-zoom-in', className)}
      style={{ aspectRatio: ratio.replace('/', ' / ') }}
      aria-label={onClick ? `预览 ${alt}` : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 签名 URL 与派生图走对象存储，不走 Next Image 优化器 */}
      <img
        src={pickSrc(asset, variant)}
        alt={alt}
        width={width}
        height={height}
        sizes={sizes}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        className="h-full w-full object-contain"
        onError={() => setFailed(true)}
      />
    </button>
  );
}

export function ImageLightbox({
  open,
  onOpenChange,
  images,
  index,
  onIndexChange,
  sidebar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  images: Array<{ id: string; url: string; previewUrl?: string | null; alt: string; downloadUrl?: string }>;
  index: number;
  onIndexChange: (index: number) => void;
  sidebar?: React.ReactNode;
}): React.JSX.Element | null {
  const [zoom, setZoom] = useState(1);
  const current = images[index];
  const src = current?.previewUrl || current?.url;

  useEffect(() => {
    if (!open) setZoom(1);
  }, [open, index]);

  const canPrev = index > 0;
  const canNext = index < images.length - 1;

  const title = useMemo(() => current?.alt ?? '图片预览', [current]);

  if (!current) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="full"
      theme="dark"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-xs text-fg-muted tabular">
            {index + 1} / {images.length}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="缩小" onClick={() => setZoom((z) => Math.max(1, z - 0.25))}>
              <ZoomOut size={16} />
            </Button>
            <Button variant="ghost" size="icon" aria-label="放大" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
              <ZoomIn size={16} />
            </Button>
            {current.downloadUrl ? (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Download size={14} />}
                onClick={() => triggerDownload(current.downloadUrl as string, `${current.id}.png`)}
              >
                下载
              </Button>
            ) : null}
            <Button variant="ghost" size="icon" aria-label="关闭预览" onClick={() => onOpenChange(false)}>
              <X size={16} />
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_16rem]">
        <div className="relative flex min-h-[50vh] items-center justify-center overflow-auto bg-bg">
          {canPrev ? (
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-2 top-1/2 -translate-y-1/2"
              aria-label="上一张"
              onClick={() => onIndexChange(index - 1)}
            >
              <ChevronLeft size={20} />
            </Button>
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={current.alt}
            className="max-h-[70vh] max-w-full object-contain"
            style={{ transform: `scale(${zoom})` }}
          />
          {canNext ? (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-1/2 -translate-y-1/2"
              aria-label="下一张"
              onClick={() => onIndexChange(index + 1)}
            >
              <ChevronRight size={20} />
            </Button>
          ) : null}
        </div>
        {sidebar ? <aside className="text-sm text-fg-muted">{sidebar}</aside> : null}
      </div>
    </Dialog>
  );
}
