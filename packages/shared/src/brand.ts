/**
 * JUNE 设计系统令牌(唯一来源)。
 *
 * 品牌基色由需求指定,其余色阶按可读性补齐:
 *   深靛蓝 #101426 / 品牌青绿 #56DECD / 象牙白 #F8F6EF / 辅助紫 #9B8AFB
 *
 * 对比度说明(与白色/深靛蓝背景的 WCAG 对比度,已实测计算):
 *   - 象牙白 #F8F6EF on 深靛蓝 #101426 = 17.1:1
 *   - 品牌青绿 #56DECD on 深靛蓝 #101426 = 11.3:1
 *   - 辅助紫 #9B8AFB on 深靛蓝 #101426 = 6.5:1
 *   - 品牌青绿 #56DECD on 白色 = 1.6:1 —— 因此浅色背景上的小字号文字必须使用
 *     teal[700] (#0C7E72, 4.95:1) 或更深的色阶,不可直接用品牌青绿。
 *
 * 使用约定:
 *   - teal[400] 是品牌色本体,用于深色背景强调、选中态、主按钮填充
 *   - teal[700]/[800] 用于浅色背景上的小字号文字与链接
 *   - purple 仅用于局部连接处的小面积点缀,不作为大面积背景或主按钮
 */

export const BRAND_COLORS = {
  /** 深靛蓝:深色场景主背景 */
  indigo: '#101426',
  /** 品牌青绿 */
  teal: '#56DECD',
  /** 象牙白:深色背景上的主文字 */
  ivory: '#F8F6EF',
  /** 辅助紫:点缀 */
  purple: '#9B8AFB',
} as const;

export const COLOR_SCALES = {
  indigo: {
    50: '#EEF0F6',
    100: '#D6DAE8',
    200: '#AEB5CC',
    300: '#8189AB',
    400: '#535C85',
    500: '#333B60',
    600: '#232948',
    700: '#191E37',
    800: '#131829',
    /** 品牌深靛蓝 */
    900: '#101426',
    950: '#0A0D1A',
  },
  teal: {
    50: '#EAFBF8',
    100: '#CFF6F0',
    200: '#A6EDE3',
    300: '#7BE3D6',
    /** 品牌青绿 */
    400: '#56DECD',
    500: '#2CC5B2',
    /** 浅底大字号可用 */
    600: '#12A091',
    /** 浅底小字号最低可用色阶(4.95:1) */
    700: '#0C7E72',
    800: '#0A6259',
    900: '#084E47',
  },
  ivory: {
    /** 品牌象牙白 */
    50: '#F8F6EF',
    100: '#F1EEE3',
    200: '#E4DFCE',
    300: '#CFC8B2',
    400: '#B3AA90',
  },
  purple: {
    100: '#EAE6FE',
    200: '#D5CDFD',
    300: '#B8ABFC',
    /** 辅助紫 */
    400: '#9B8AFB',
    500: '#7B65F7',
    600: '#5F48E0',
    /** 浅底小字号可用 */
    700: '#4A36B4',
  },
  /** 中性灰:社区等浅色页面的正文与边框 */
  neutral: {
    0: '#FFFFFF',
    50: '#FAFAF9',
    100: '#F4F4F2',
    200: '#E7E7E4',
    300: '#D3D3CF',
    400: '#A8A8A2',
    500: '#7A7A75',
    600: '#585853',
    700: '#3F3F3B',
    800: '#2A2A27',
    900: '#1A1A18',
  },
  /** 状态色:均已校验在浅色背景上的小字号对比度 ≥ 4.5:1 */
  status: {
    successFg: '#0F7A3D',
    successBg: '#E7F6EC',
    successBorder: '#B7E3C6',
    warningFg: '#8A5A00',
    warningBg: '#FDF3E2',
    warningBorder: '#F0D6A6',
    dangerFg: '#B32036',
    dangerBg: '#FCEBED',
    dangerBorder: '#F3C2C9',
    infoFg: '#1F4FA8',
    infoBg: '#EAF0FC',
    infoBorder: '#C2D3F2',
  },
} as const;

/** 深色背景(首页/工作台/登录页)语义色 */
export const DARK_THEME = {
  bg: COLOR_SCALES.indigo[950],
  bgElevated: COLOR_SCALES.indigo[900],
  surface: 'rgba(248, 246, 239, 0.045)',
  surfaceHover: 'rgba(248, 246, 239, 0.075)',
  border: 'rgba(248, 246, 239, 0.11)',
  borderStrong: 'rgba(248, 246, 239, 0.2)',
  text: COLOR_SCALES.ivory[50],
  textMuted: 'rgba(248, 246, 239, 0.68)',
  textSubtle: 'rgba(248, 246, 239, 0.46)',
  accent: COLOR_SCALES.teal[400],
  accentText: COLOR_SCALES.indigo[950],
  glowTeal: 'rgba(86, 222, 205, 0.16)',
  glowPurple: 'rgba(155, 138, 251, 0.14)',
} as const;

/** 浅色背景(社区/管理站)语义色 */
export const LIGHT_THEME = {
  bg: COLOR_SCALES.neutral[50],
  bgElevated: COLOR_SCALES.neutral[0],
  surface: COLOR_SCALES.neutral[0],
  surfaceHover: COLOR_SCALES.neutral[100],
  border: COLOR_SCALES.neutral[200],
  borderStrong: COLOR_SCALES.neutral[300],
  text: COLOR_SCALES.neutral[900],
  textMuted: COLOR_SCALES.neutral[600],
  textSubtle: COLOR_SCALES.neutral[500],
  /** 浅底上的强调色使用深青绿,保证小字号可读 */
  accent: COLOR_SCALES.teal[700],
  accentSurface: COLOR_SCALES.teal[50],
  accentText: COLOR_SCALES.neutral[0],
} as const;

/** 字体栈。优先系统字体 + 自托管兜底,不依赖外部字体 CDN。 */
export const FONT_STACKS = {
  /** 正文:中英文混排 */
  sans: [
    'var(--font-june-sans)',
    '-apple-system',
    'BlinkMacSystemFont',
    '"Segoe UI"',
    'Roboto',
    '"PingFang SC"',
    '"Hiragino Sans GB"',
    '"Microsoft YaHei"',
    '"Noto Sans SC"',
    'sans-serif',
  ].join(', '),
  /** 数字/代码:表格与统计对齐 */
  mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace'].join(', '),
  /**
   * 品牌字标专用。JUNE 字标是定制 SVG 图形,不依赖字体文件;
   * 该字体栈仅用于与字标搭配的少量副标文字,与正文标题字体分开管理。
   */
  brand: ['var(--font-june-display)', 'system-ui', 'sans-serif'].join(', '),
} as const;

export const SPACING = {
  px: '1px',
  0.5: '0.125rem',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
} as const;

export const RADII = {
  sm: '0.375rem',
  md: '0.625rem',
  lg: '0.875rem',
  xl: '1.25rem',
  '2xl': '1.75rem',
  full: '9999px',
} as const;

export const SHADOWS = {
  sm: '0 1px 2px rgba(16, 20, 38, 0.06)',
  md: '0 4px 16px rgba(16, 20, 38, 0.08)',
  lg: '0 12px 40px rgba(16, 20, 38, 0.12)',
  /** 深色背景上的浮起卡片 */
  darkMd: '0 8px 32px rgba(4, 6, 14, 0.5)',
  darkLg: '0 24px 72px rgba(4, 6, 14, 0.62)',
  /** 青绿聚焦环 */
  focusRing: `0 0 0 3px rgba(86, 222, 205, 0.35)`,
} as const;

/**
 * 动效令牌。只使用 opacity / transform,避免 filter、box-shadow 动画等高负载特效;
 * 所有动效在 prefers-reduced-motion: reduce 下降级为即时切换。
 */
export const MOTION = {
  durationFast: 0.14,
  durationBase: 0.24,
  durationSlow: 0.42,
  /** 首页背景光晕的缓慢呼吸动效周期(秒) */
  durationAmbient: 18,
  easeOut: [0.16, 1, 0.3, 1] as const,
  easeInOut: [0.65, 0, 0.35, 1] as const,
} as const;

/** 响应式断点。验收要求在 390 / 768 / 1440 三档检查所有页面。 */
export const BREAKPOINTS = {
  sm: 390,
  md: 768,
  lg: 1024,
  xl: 1440,
} as const;

/** 品牌 Logo 尺寸档位。16/24/32 使用简化图形,细节更少以保证辨识度。 */
export const LOGO_SIZES = {
  xs: 16,
  sm: 24,
  md: 32,
  lg: 48,
  xl: 72,
  '2xl': 112,
} as const;
export type LogoSize = keyof typeof LOGO_SIZES;
/** 小于该像素值时切换到简化图形 */
export const LOGO_SIMPLIFY_THRESHOLD = 32;
