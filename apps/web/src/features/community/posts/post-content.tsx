'use client';

import type { PostDetail } from '@june/shared';
import { useCallback, useMemo, useState } from 'react';

import { ImageLightbox } from '@/components/media/asset-image';

/**
 * 帖子正文。
 *
 * 关于 `dangerouslySetInnerHTML`:
 * `contentHtml` **已经在服务端清洗过**,清洗发生在 `apps/api/src/modules/community/html-sanitize.ts`
 * (白名单标签与属性、剥离所有 on* 事件、a 强制 rel、img 的 src 必须指向本平台资产;
 * 发布 / 编辑 / 草稿保存三条写入路径都必须经过它,落库的永远是清洗后的结果)。
 * 因此前端**不再引入 DOMPurify 做二次过滤**,也不允许在这里放宽任何规则。
 *
 * 正文图片点击打开灯箱:用事件委托而不是给每个 img 绑事件,
 * 因为这段 HTML 不是 React 渲染出来的,拿不到节点引用。
 */
export function PostContent({
  contentHtml,
  images,
  title,
}: {
  contentHtml: string;
  images: PostDetail['images'];
  title: string;
}): React.JSX.Element {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const lightboxImages = useMemo(
    () =>
      images.map((image, index) => ({
        id: image.assetId,
        url: image.url,
        previewUrl: image.previewUrl,
        alt: `《${title}》的第 ${index + 1} 张图片`,
        downloadUrl: image.url,
      })),
    [images, title],
  );

  /** 正文里的 src 可能是原图 / 预览图 / 缩略图,按对象键的公共部分匹配到同一张资产 */
  const findIndexBySrc = useCallback(
    (src: string): number => {
      const pathOf = (value: string): string => {
        try {
          return decodeURIComponent(new URL(value, window.location.origin).pathname);
        } catch {
          return value;
        }
      };
      const target = pathOf(src);
      return images.findIndex((image) => {
        const candidates = [image.url, image.previewUrl].filter(Boolean) as string[];
        return candidates.some((candidate) => {
          const path = pathOf(candidate);
          // 去掉派生图后缀差异,比较文件名主体
          const strip = (p: string): string => p.replace(/\.(thumb|preview)\.[a-z0-9]+$/i, '');
          return strip(path) === strip(target) || path === target;
        });
      });
    },
    [images],
  );

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.tagName !== 'IMG') return;
      const src = target.getAttribute('src');
      if (!src) return;

      const index = findIndexBySrc(src);
      if (index >= 0) setLightboxIndex(index);
    },
    [findIndexBySrc],
  );

  return (
    <>
      {/* eslint-disable-next-line react/no-danger -- 内容已由服务端 html-sanitize.ts 白名单清洗 */}
      <div
        className="june-prose [&_img]:cursor-zoom-in"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: contentHtml }}
      />

      {lightboxImages.length > 0 ? (
        <ImageLightbox
          open={lightboxIndex !== null}
          onOpenChange={(open) => setLightboxIndex(open ? (lightboxIndex ?? 0) : null)}
          images={lightboxImages}
          index={lightboxIndex ?? 0}
          onIndexChange={(index) => setLightboxIndex(index)}
        />
      ) : null}
    </>
  );
}
