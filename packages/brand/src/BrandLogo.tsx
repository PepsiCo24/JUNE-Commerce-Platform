/** Shared SVG logo, redrawn from the supplied JUNE reference artwork. */

import type { CSSProperties, ReactElement } from 'react';

import { BRAND_LOGO_SUBTITLE, BRAND_SHORT_NAME, COLOR_SCALES, LOGO_SIZES, type LogoSize } from '@june/shared';

import { JE_PATHS, JUNE_PATHS, LOGO_LAYOUTS } from './geometry';

const PALETTES = {
  dark: {
    primary: COLOR_SCALES.ivory[50],
    accent: COLOR_SCALES.teal[400],
    node: COLOR_SCALES.purple[400],
    subtitle: COLOR_SCALES.ivory[50],
  },
  light: {
    primary: COLOR_SCALES.indigo[900],
    accent: COLOR_SCALES.teal[400],
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

export type BrandLogoVariant = 'icon' | 'horizontal' | 'full';
export type BrandLogoTheme = 'dark' | 'light' | 'mono';
export type BrandLogoSize = LogoSize | number;

export interface BrandLogoProps {
  variant?: BrandLogoVariant;
  theme?: BrandLogoTheme;
  size?: BrandLogoSize;
  showSubtitle?: boolean;
  title?: string;
  'aria-label'?: string;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

interface Palette {
  readonly primary: string;
  readonly accent: string;
  readonly node: string;
  readonly subtitle: string;
}

function IconGlyph({
  palette,
  transform,
  showNode,
}: {
  palette: Palette;
  transform: string | undefined;
  showNode: boolean;
}): ReactElement {
  return (
    <g transform={transform}>
      {JE_PATHS.bars.map((d) => (
        <path key={d} d={d} fill={palette.accent} />
      ))}
      {showNode ? (
        <>
          <path d={JE_PATHS.overlap} fill={palette.node} />
          <path d={JE_PATHS.fold} fill={palette.primary} fillOpacity={0.18} />
        </>
      ) : null}
      <path d={JE_PATHS.stem} fill={palette.primary} />
      <path d={JE_PATHS.hook} fill={palette.primary} />
    </g>
  );
}

function WordmarkGlyph({ palette }: { palette: Palette }): ReactElement {
  return (
    <g>
      {JUNE_PATHS.map((d, index) => (
        <path key={d} d={d} fill={index === 3 ? palette.accent : palette.primary} />
      ))}
    </g>
  );
}

function SubtitleText({ palette }: { palette: Palette }): ReactElement {
  return (
    <text
      x={0}
      y={257}
      fontFamily="Arial, Helvetica, sans-serif"
      fontSize={38}
      fontWeight={400}
      fill={palette.subtitle}
    >
      {Array.from(BRAND_LOGO_SUBTITLE).map((letter, index) => (
        <tspan key={index} x={index * (763 / (BRAND_LOGO_SUBTITLE.length - 1))}>
          {letter}
        </tspan>
      ))}
    </text>
  );
}

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
  const wantsSubtitle = showSubtitle ?? variant === 'full';
  const layoutKey: BrandLogoVariant = variant === 'icon' ? 'icon' : wantsSubtitle ? 'full' : 'horizontal';
  const layout = LOGO_LAYOUTS[layoutKey];
  const palette: Palette = PALETTES[theme];

  const height = typeof size === 'number' ? size : LOGO_SIZES[size];
  const width = Number(((height * layout.width) / layout.height).toFixed(2));

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
      preserveAspectRatio="xMidYMid meet"
      focusable="false"
      className={className}
      style={{ display: 'block', flexShrink: 0, ...style }}
      data-testid={dataTestId}
      {...a11yProps}
    >
      {title === undefined ? null : <title>{title}</title>}

      <IconGlyph palette={palette} transform={layout.iconTransform} showNode={theme !== 'mono'} />

      {layoutKey === 'icon' ? null : (
        <g transform={`translate(447 ${layout.wordmarkY})`}>
          <WordmarkGlyph palette={palette} />
        </g>
      )}

      {layoutKey === 'full' ? (
        <g transform="translate(447 0)">
          <SubtitleText palette={palette} />
        </g>
      ) : null}
    </svg>
  );
}

export const BRAND_LOGO_NAME = BRAND_SHORT_NAME;
