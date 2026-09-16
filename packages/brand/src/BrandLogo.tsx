/**
 * BrandLogo —— JUNE 品牌标识的**唯一**渲染入口。
 *
 * ⚠ 待对照用户提供的品牌设计图校准(当前几何为按书面规则制作的初稿)。
 *   校准时只需要改本文件顶部的几何常量,所有页面会一起更新。
 *
 * 约束:
 *   · 所有页面的 Logo 必须来自这个组件,禁止各页面自行拼 <svg> 或 <img>。
 *   · 内联 SVG 而不是 <img>:只有内联才能让笔画跟随主题换色、跟随 currentColor。
 *   · 纯展示组件,无 state / 无 hooks / 无事件 / 无副作用,
 *     因此可以直接在 React Server Component 中渲染,不需要 'use client'。
 *   · 所有常量(品牌名、副标、尺寸档、简化阈值、色阶)都来自 @june/shared,
 *     本文件不硬编码任何色值或文案。
 */

import type { CSSProperties, ReactElement } from 'react';

import {
  BRAND_LOGO_SUBTITLE,
  BRAND_SHORT_NAME,
  COLOR_SCALES,
  FONT_STACKS,
  LOGO_SIMPLIFY_THRESHOLD,
  LOGO_SIZES,
  type LogoSize,
} from '@june/shared';

// ---------------------------------------------------------------------------
// 几何常量
//
// 图标画在 64×64 栅格上,墨迹精确占据 8..56 的 48×48 正方形。
// 字标画在 234×96 栅格上,大写字高 56(顶线 y=20 / 基线 y=76)。
// 两者与 packages/brand/assets/ 下的 SVG 源文件逐坐标一致。
// ---------------------------------------------------------------------------

/**
 * 完整细节版图标:E 的三道横画 + J 的竖笔与四分之一圆弧。
 * E 的上横走到 x=52 就换色变成 J 的竖笔,这是两个字母唯一的实体融合点;
 * E 的下横在 x=22 收笔,与圆弧落点之间留 4 单位缺口,由紫色连接珠桥接。
 */
const ICON_DETAILED = {
  strokeWidth: 8,
  /** E:上横(右端延伸出去给 J)+ 竖脊 + 下横;以及单独的中横 */
  accentPaths: ['M52 12 H12 V51 H22', 'M12 31 H30'],
  /** J:竖笔 + 圆心 (34,33) 半径 18 的四分之一弧,切线与竖笔、下横完全连续 */
  primaryPath: 'M52 12 V33 A18 18 0 0 1 34 51',
  /** J 与 E 的连接处:坐在缺口上并压住两端笔尖 */
  node: { cx: 28, cy: 51, r: 5 },
} as const;

/**
 * 简化版图标:笔画由 8 加粗到 10、中横缩短、下横缺口由 4 单位收到 3 单位。
 *
 * 中横是缩短而不是删除:实测整条删掉之后,图标在 24 / 32px 下会退化成
 * 「圆角方块 + 右下角缺口」,E 完全消失,辨识度反而下降。
 * 本图标是等线设计(笔画同宽),并不存在「最细的笔画」,
 * 真正先在小尺寸下崩掉的是缺口与连接珠,不是中横。
 * 详见 docs/BRAND.md 的辨识度检查一节。
 *
 * 连接珠加粗后正好内接于笔画带(46..56),不再外凸,小尺寸下边缘更干净。
 * 外框与墨迹范围与完整版完全相同(8..56),两者可以原地互换而不产生跳动。
 */
const ICON_SIMPLIFIED = {
  strokeWidth: 10,
  accentPaths: ['M51 13 H13 V51 H20', 'M13 32 H28'],
  primaryPath: 'M51 13 V33 A18 18 0 0 1 33 51',
  node: { cx: 26, cy: 51, r: 5 },
} as const;

/** JUNE 字标:定制手绘 path,不依赖任何字体文件。 */
const WORDMARK = {
  strokeWidth: 12,
  /** JUN —— 代表创始人「俊哥」 */
  junPaths: ['M24 26 V52 A18 18 0 0 1 6 70', 'M56 26 V52 A18 18 0 0 0 92 52 V26', 'M124 70 V26 L160 70 V26'],
  /** E —— 承接 E-Commerce,单独取品牌青绿 */
  ePaths: ['M228 26 H192 V70 H228', 'M192 48 H220'],
  /** 字标墨迹宽度,副标用 textLength 对齐到同一宽度 */
  width: 234,
} as const;

/** 副标 COMMERCE PLATFORM 的排版参数(字号 17 时大写字高约 12)。 */
const SUBTITLE = {
  x: 106,
  baseline: 104,
  fontSize: 17,
  fontWeight: 600,
} as const;

/**
 * 三种版式的画布。
 *   · iconBoxUnits = 图标 64 栅格在该画布中占据的高度,用于换算图标的真实渲染像素,
 *     进而决定是否切换简化图形。
 *   · horizontal:图标 ×1.5 后笔画宽 12,与字标笔画宽 12 一致,两者灰度匹配。
 *   · full:图标垂直居中对齐「字标 + 副标」整个文字块(中线 y=62)。
 */
const LAYOUTS = {
  icon: { width: 64, height: 64, iconBoxUnits: 64, iconTransform: undefined },
  horizontal: { width: 348, height: 96, iconBoxUnits: 96, iconTransform: 'scale(1.5)' },
  full: { width: 348, height: 124, iconBoxUnits: 96, iconTransform: 'translate(0 14) scale(1.5)' },
} as const;

/** 字标在横向/完整版式中的位置:与图标墨迹右缘留 22 单位间距。 */
const WORDMARK_TRANSFORM = 'translate(106 0)';

// ---------------------------------------------------------------------------
// 主题配色
//
// 全部取自 COLOR_SCALES,不新起色值。
// 浅色主题刻意不使用品牌青绿本体 #56DECD(白底仅 1.6:1)与辅助紫 #9B8AFB
// (白底约 2.8:1),二者都低于 WCAG 对图形元素要求的 3:1;
// 浅底一律降到 teal[700] #0C7E72(4.95:1)与 purple[500] #7B65F7(约 4.2:1)。
// ---------------------------------------------------------------------------

const PALETTES = {
  dark: {
    /** J / JUN */
    primary: COLOR_SCALES.ivory[50],
    /** E */
    accent: COLOR_SCALES.teal[400],
    /** J 与 E 的连接点 */
    node: COLOR_SCALES.purple[400],
    subtitle: COLOR_SCALES.ivory[200],
  },
  light: {
    primary: COLOR_SCALES.indigo[900],
    accent: COLOR_SCALES.teal[700],
    node: COLOR_SCALES.purple[500],
    subtitle: COLOR_SCALES.neutral[600],
  },
  mono: {
    primary: 'currentColor',
    accent: 'currentColor',
    node: 'currentColor',
    subtitle: 'currentColor',
  },
} as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 版式:纯图标 / 图标+字标 / 图标+字标+副标 */
export type BrandLogoVariant = 'icon' | 'horizontal' | 'full';

/**
 * 主题:
 *   · dark —— 深色背景,象牙白 + 品牌青绿
 *   · light —— 浅色背景,深靛蓝 + teal[700] #0C7E72(小字号可读的深青绿)
 *   · mono —— 全部 currentColor,由父元素的 CSS color 决定
 */
export type BrandLogoTheme = 'dark' | 'light' | 'mono';

/** 尺寸:LOGO_SIZES 的档位名,或直接给一个像素高度 */
export type BrandLogoSize = LogoSize | number;

export interface BrandLogoProps {
  /** 版式,默认 'horizontal' */
  variant?: BrandLogoVariant;
  /** 主题,默认 'dark' */
  theme?: BrandLogoTheme;
  /** 渲染高度(像素)或 LOGO_SIZES 档位名,默认 'md'(32px) */
  size?: BrandLogoSize;
  /**
   * 是否显示 COMMERCE PLATFORM 副标。
   * 不传时按 variant 决定('full' 显示,其余不显示);
   * 显式传 true 会把 'horizontal' 提升为完整版式,传 false 会把 'full' 降为横向版式。
   * 对 variant='icon' 无效。
   */
  showSubtitle?: boolean;
  /** SVG 的 <title>,会作为悬停提示与无障碍名称 */
  title?: string;
  /** 无障碍名称。与 title 都不传时,组件按装饰性图形处理(aria-hidden + role="presentation") */
  'aria-label'?: string;
  className?: string;
  style?: CSSProperties;
  /** 透传给根 <svg>,便于测试定位 */
  'data-testid'?: string;
}

// ---------------------------------------------------------------------------
// 内部片段
// ---------------------------------------------------------------------------

interface Palette {
  readonly primary: string;
  readonly accent: string;
  readonly node: string;
  readonly subtitle: string;
}

function IconGlyph({
  palette,
  simplified,
  transform,
}: {
  palette: Palette;
  simplified: boolean;
  transform: string | undefined;
}): ReactElement {
  const glyph = simplified ? ICON_SIMPLIFIED : ICON_DETAILED;

  return (
    <g transform={transform}>
      <g fill="none" strokeWidth={glyph.strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        {glyph.accentPaths.map((d) => (
          <path key={d} d={d} stroke={palette.accent} />
        ))}
        <path d={glyph.primaryPath} stroke={palette.primary} />
      </g>
      {/* 紫色点缀:J 的圆弧闭合回 E 的连接处 */}
      <circle cx={glyph.node.cx} cy={glyph.node.cy} r={glyph.node.r} fill={palette.node} />
    </g>
  );
}

function WordmarkGlyph({ palette }: { palette: Palette }): ReactElement {
  return (
    <g
      transform={WORDMARK_TRANSFORM}
      fill="none"
      strokeWidth={WORDMARK.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {WORDMARK.junPaths.map((d) => (
        <path key={d} d={d} stroke={palette.primary} />
      ))}
      {WORDMARK.ePaths.map((d) => (
        <path key={d} d={d} stroke={palette.accent} />
      ))}
    </g>
  );
}

function SubtitleText({ palette }: { palette: Palette }): ReactElement {
  return (
    <text
      x={SUBTITLE.x}
      y={SUBTITLE.baseline}
      // 用 textLength 把副标锁死成与字标等宽,不同系统字体下宽度都一致
      textLength={WORDMARK.width}
      lengthAdjust="spacing"
      fontFamily={FONT_STACKS.brand}
      fontSize={SUBTITLE.fontSize}
      fontWeight={SUBTITLE.fontWeight}
      fill={palette.subtitle}
    >
      {BRAND_LOGO_SUBTITLE}
    </text>
  );
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/**
 * JUNE 品牌标识。
 *
 * @example 深色导航栏上的横向标识
 * ```tsx
 * <BrandLogo variant="horizontal" theme="dark" size="lg" title="JUNE 首页" />
 * ```
 *
 * @example 浅色社区页的完整标识(副标使用 #0C7E72 体系的浅底配色)
 * ```tsx
 * <BrandLogo variant="full" theme="light" size={64} />
 * ```
 *
 * @example 跟随文字颜色的装饰性小图标(自动切换简化图形)
 * ```tsx
 * <span style={{ color: 'var(--text-muted)' }}>
 *   <BrandLogo variant="icon" theme="mono" size="xs" />
 * </span>
 * ```
 */
export function BrandLogo({
  variant = 'horizontal',
  theme = 'dark',
  size = 'md',
  showSubtitle,
  title,
  'aria-label': ariaLabel,
  className,
  style,
  'data-testid': dataTestId,
}: BrandLogoProps): ReactElement {
  // 版式:showSubtitle 显式传值时覆盖 variant 的默认行为
  const wantsSubtitle = showSubtitle ?? variant === 'full';
  const layoutKey: BrandLogoVariant = variant === 'icon' ? 'icon' : wantsSubtitle ? 'full' : 'horizontal';
  const layout = LAYOUTS[layoutKey];

  const palette: Palette = PALETTES[theme];

  // 渲染尺寸:size 指的是**渲染高度**,宽度按 viewBox 比例推导,永远不会被拉伸
  const height = typeof size === 'number' ? size : LOGO_SIZES[size];
  const width = Number(((height * layout.width) / layout.height).toFixed(2));

  /**
   * 简化切换:比较「图标 64 栅格实际渲染出多少像素」与 LOGO_SIMPLIFY_THRESHOLD。
   * variant='icon' 与 'horizontal' 时图标栅格铺满整个高度,该值就等于 height,
   * 与「渲染高度 ≤ 32 用简化图形」的规则完全一致;
   * variant='full' 时图标只占画布高度的 96/124,按实际占比折算更准确。
   */
  const iconRenderedPx = (height * layout.iconBoxUnits) / layout.height;
  const simplified = iconRenderedPx <= LOGO_SIMPLIFY_THRESHOLD;

  // 无障碍:既没有 title 也没有 aria-label 时,视为装饰性图形交给屏幕阅读器忽略
  const accessibleName = ariaLabel ?? title;
  const decorative = accessibleName === undefined;

  const a11yProps = decorative
    ? ({ 'aria-hidden': true, role: 'presentation' } as const)
    : ({ role: 'img', 'aria-label': accessibleName } as const);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={width}
      height={height}
      // 等比缩放:即使外层容器给了不成比例的宽高,图形也只会居中留白,不会变形
      preserveAspectRatio="xMidYMid meet"
      focusable="false"
      className={className}
      // flexShrink: 0 防止 flex 容器把标识压扁(压扁 = 变形)
      style={{ display: 'block', flexShrink: 0, ...style }}
      data-testid={dataTestId}
      {...a11yProps}
    >
      {title === undefined ? null : <title>{title}</title>}

      <IconGlyph palette={palette} simplified={simplified} transform={layout.iconTransform} />

      {layoutKey === 'icon' ? null : <WordmarkGlyph palette={palette} />}
      {layoutKey === 'full' ? <SubtitleText palette={palette} /> : null}
    </svg>
  );
}

/** 品牌简称,便于调用方在 title / aria-label 里复用同一份拼写。 */
export const BRAND_LOGO_NAME = BRAND_SHORT_NAME;
