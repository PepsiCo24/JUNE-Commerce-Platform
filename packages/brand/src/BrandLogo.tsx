/**
 * BrandLogo —— JUNE 品牌标识的**唯一**渲染入口。
 *
 * 几何已按官方品牌设计稿校准(左 J 左向弯钩 + 右 E 三横 + 紫色连接珠)。
 * 只需改本文件顶部的几何常量,所有页面会一起更新。
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
 * 完整细节版图标(对照官方设计稿):
 *   · J(主色)在左:竖笔 + 左下四分之一弧(与字标 J 同构)
 *   · E(青绿)在右:三道独立横画,无竖脊(竖脊由 J 承担)
 *   · 紫色连接珠落在 J 内侧凹槽(竖笔与弯钩之间的负空间),
 *     画在 J 笔画之下;切勿压在钩底外侧,否则会露出实心紫点
 */
const ICON_DETAILED = {
  strokeWidth: 8,
  /** E:上 / 中 / 下三道横画 */
  accentPaths: ['M28 12 H52', 'M34 31 H48', 'M30 51 H52'],
  /** J:竖笔 + 圆心 (20,36) 半径 16 的左向四分之一弧 */
  primaryPath: 'M20 12 V36 A16 16 0 0 1 8 52',
  /** J 内侧凹槽质心(对照设计稿取样 ≈29,39) */
  node: { cx: 29, cy: 39, r: 5 },
} as const;

/**
 * 简化版图标:笔画加粗到 10、中横略缩短,便于 ≤32px 渲染。
 * 外框与墨迹范围与完整版一致(8..56),可原地互换。
 * 单色 / 应用图标场景不画连接珠(设计稿 mono / app icon 无紫色点)。
 */
const ICON_SIMPLIFIED = {
  strokeWidth: 10,
  accentPaths: ['M29 13 H51', 'M33 32 H47', 'M29 51 H51'],
  primaryPath: 'M19 13 V36 A15 15 0 0 1 9 51',
  node: { cx: 29, cy: 39, r: 4.5 },
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
// 全部取自 COLOR_SCALES。设计稿深浅底的 E 均使用品牌青绿本体 teal[400]。
// ---------------------------------------------------------------------------

const PALETTES = {
  dark: {
    /** J / JUN */
    primary: COLOR_SCALES.ivory[50],
    /** E —— 设计稿深浅底均使用品牌青绿本体 */
    accent: COLOR_SCALES.teal[400],
    /** J 弯钩内侧连接珠(深底) */
    node: COLOR_SCALES.purple[400],
    subtitle: COLOR_SCALES.ivory[200],
  },
  light: {
    primary: COLOR_SCALES.indigo[900],
    accent: COLOR_SCALES.teal[400],
    /** 浅底连接珠用更深一档,保证对比度 */
    node: COLOR_SCALES.purple[500],
    subtitle: COLOR_SCALES.indigo[900],
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
  showNode,
}: {
  palette: Palette;
  simplified: boolean;
  transform: string | undefined;
  /** mono / 应用图标场景不画紫色连接珠 */
  showNode: boolean;
}): ReactElement {
  const glyph = simplified ? ICON_SIMPLIFIED : ICON_DETAILED;

  return (
    <g transform={transform}>
      {/* E 在最底 */}
      <g fill="none" strokeWidth={glyph.strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        {glyph.accentPaths.map((d) => (
          <path key={d} d={d} stroke={palette.accent} />
        ))}
      </g>
      {/* 紫珠夹在 E 与 J 之间:J 覆盖后只露出弯钩内侧的新月形过渡 */}
      {showNode ? (
        <circle cx={glyph.node.cx} cy={glyph.node.cy} r={glyph.node.r} fill={palette.node} />
      ) : null}
      {/* J 在最上,盖住紫珠外沿 */}
      <g fill="none" strokeWidth={glyph.strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        <path d={glyph.primaryPath} stroke={palette.primary} />
      </g>
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

      <IconGlyph
        palette={palette}
        simplified={simplified}
        transform={layout.iconTransform}
        showNode={theme !== 'mono'}
      />

      {layoutKey === 'icon' ? null : <WordmarkGlyph palette={palette} />}
      {layoutKey === 'full' ? <SubtitleText palette={palette} /> : null}
    </svg>
  );
}

/** 品牌简称,便于调用方在 title / aria-label 里复用同一份拼写。 */
export const BRAND_LOGO_NAME = BRAND_SHORT_NAME;
