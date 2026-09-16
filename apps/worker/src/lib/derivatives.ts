/**
 * 派生图规格计算(纯函数,便于单元测试)。
 *
 * 规格来自 @june/shared 的 DERIVATIVE_SPECS,不在这里另写数值。
 *
 * 三条硬性规则:
 *  1. **不放大**:sharp 的 withoutEnlargement + 这里的 scale <= 1 双保险。
 *     小图被放大只会变糊并且白占空间。
 *  2. **保留透明背景**:源图有 alpha 时绝不能落到 JPEG(JPEG 无 alpha 通道,
 *     透明区会被填成黑色或白色,商品抠图会直接报废)。
 *     首选 WebP —— 它同时支持有损压缩与 alpha,是"体积小 + 保留透明"的唯一兼顾项。
 *  3. **保持比例**:fit: 'inside',不裁切不拉伸。
 */
import { DERIVATIVE_SPECS, type DerivativeName } from '@june/shared';

export type DerivativeFormat = 'webp' | 'png' | 'jpeg';

export interface DerivativePlan {
  name: DerivativeName;
  /** 目标宽高(已按 fit: 'inside' 且不放大计算) */
  width: number;
  height: number;
  /** 是否真的需要缩放。等于源尺寸时仍会转码(统一成 WebP),但不做 resize */
  willResize: boolean;
  format: DerivativeFormat;
  /** WebP 编码失败时的退路。有 alpha 走 PNG,无 alpha 走 JPEG。 */
  fallbackFormat: Exclude<DerivativeFormat, 'webp'>;
  quality: number;
  /** 是否需要输出 alpha 通道 */
  keepAlpha: boolean;
  /**
   * 是否做轻微锐化。
   * 取舍:预览图是详情页主视觉,缩放后商品上的小字容易发虚,轻微锐化能救回可读性;
   * 但锐化过度会在纯色块边缘产生描边,反而像"P 过"。因此只对 preview 且**确实缩小过**
   * 的图做 sigma 0.5 的极轻锐化,thumb(400px 以内)不锐化——那个尺寸锐化只会放大噪点。
   */
  sharpen: boolean;
  mimeType: string;
}

const MIME_BY_FORMAT: Record<DerivativeFormat, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
};

export interface PlanInput {
  name: DerivativeName;
  sourceWidth: number;
  sourceHeight: number;
  /** sharp metadata.hasAlpha */
  hasAlpha: boolean;
}

export function planDerivative(input: PlanInput): DerivativePlan {
  const spec = DERIVATIVE_SPECS[input.name];
  const sourceWidth = Math.max(1, Math.floor(input.sourceWidth));
  const sourceHeight = Math.max(1, Math.floor(input.sourceHeight));

  // fit: 'inside' + withoutEnlargement:scale 永不超过 1
  const scale = Math.min(spec.maxWidth / sourceWidth, spec.maxHeight / sourceHeight, 1);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const willResize = scale < 1;

  const format: DerivativeFormat = 'webp';
  const fallbackFormat: Exclude<DerivativeFormat, 'webp'> = input.hasAlpha ? 'png' : 'jpeg';

  return {
    name: input.name,
    width,
    height,
    willResize,
    format,
    fallbackFormat,
    quality: spec.quality,
    keepAlpha: input.hasAlpha,
    sharpen: input.name === 'preview' && willResize,
    mimeType: MIME_BY_FORMAT[format],
  };
}

export function planAllDerivatives(input: Omit<PlanInput, 'name'>): DerivativePlan[] {
  return (Object.keys(DERIVATIVE_SPECS) as DerivativeName[]).map((name) =>
    planDerivative({ ...input, name }),
  );
}

/**
 * 派生图对象键:在原图键旁边加后缀,便于按前缀一起清理。
 * 例:u/<uid>/generated_image/202609/abc.png -> u/<uid>/generated_image/202609/abc.preview.webp
 */
export function derivativeObjectKey(
  originalKey: string,
  name: DerivativeName,
  format: DerivativeFormat,
): string {
  const withoutExt = originalKey.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return `${withoutExt}.${name}.${format}`;
}

/** 写入 Asset.derivatives 的条目结构。前端通过 AssetUrlService 拼地址,不直接读这里。 */
export interface DerivativeRecord {
  key: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}

export type DerivativeMap = Partial<Record<DerivativeName, DerivativeRecord>>;
