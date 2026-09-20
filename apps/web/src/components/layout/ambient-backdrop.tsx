'use client';

import { MOTION } from '@june/shared';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/providers/preferences-provider';

/**
 * 深色场景的环境背景:低饱和光晕 + 细腻点阵纹理。
 *
 * 性能取舍(为什么不用 Motion / canvas / 渐变动画):
 *  - 光晕是 2~3 个静态 div,`filter: blur()` 只在首帧栅格化一次;
 *    呼吸动效走 CSS `@keyframes june-breathe`,只改 transform 与 opacity,
 *    完全跑在合成线程上,不触发布局与重绘,也不占用主线程 JS。
 *  - 纹理是一张 22px 的 `radial-gradient` 平铺,零图片请求、零重绘压力。
 *  - `useReducedMotion()` 为 true 时不挂 animation,直接渲染静止终态;
 *    globals.css 里的 `[data-reduced-motion]` 规则是第二道保险。
 */

interface Glow {
  key: string;
  /** 定位与尺寸。尺寸用 vw/rem 混合,移动端自动收小,不会溢出视口 */
  className: string;
  /** 设计系统光晕变量,或社区页用的加强色 */
  color: string;
  /** 错开相位,避免两团光同时到达最亮 */
  delaySeconds: number;
}

/** 登录/注册:克制到两团,卡片背后留出干净的读字区域 */
const AUTH_GLOWS: Glow[] = [
  {
    key: 'teal',
    className: '-top-24 -left-24 h-[min(26rem,70vw)] w-[min(26rem,70vw)]',
    color: 'var(--glow-teal)',
    delaySeconds: 0,
  },
  {
    key: 'purple',
    className: '-bottom-32 -right-20 h-[min(22rem,62vw)] w-[min(22rem,62vw)]',
    color: 'var(--glow-purple)',
    delaySeconds: -7,
  },
];

/** 双入口首页:青绿两团、紫一团,整体仍保持低饱和 */
const HOME_GLOWS: Glow[] = [
  {
    key: 'teal-top',
    className: '-top-40 left-[-12%] h-[min(34rem,86vw)] w-[min(34rem,86vw)]',
    color: 'var(--glow-teal)',
    delaySeconds: 0,
  },
  {
    key: 'purple-right',
    className: 'top-[18%] right-[-14%] h-[min(28rem,74vw)] w-[min(28rem,74vw)]',
    color: 'var(--glow-purple)',
    delaySeconds: -6,
  },
  {
    key: 'teal-bottom',
    className: '-bottom-44 left-[22%] h-[min(26rem,68vw)] w-[min(26rem,68vw)]',
    color: 'var(--glow-teal)',
    delaySeconds: -12,
  },
];

/** 社区信息流:两侧加大、加浓光晕,填充宽屏留白 */
const COMMUNITY_GLOWS: Glow[] = [
  {
    key: 'teal-left',
    className: 'top-[2%] left-[-20%] h-[min(40rem,82vw)] w-[min(40rem,82vw)]',
    color: 'rgba(86, 222, 205, 0.28)',
    delaySeconds: 0,
  },
  {
    key: 'purple-right',
    className: 'top-[24%] right-[-18%] h-[min(36rem,76vw)] w-[min(36rem,76vw)]',
    color: 'rgba(155, 138, 251, 0.24)',
    delaySeconds: -8,
  },
  {
    key: 'teal-bottom',
    className: 'bottom-[-20%] left-[12%] h-[min(30rem,66vw)] w-[min(30rem,66vw)]',
    color: 'rgba(86, 222, 205, 0.18)',
    delaySeconds: -14,
  },
];

export function AmbientBackdrop({
  variant = 'home',
  texture = true,
  className,
}: {
  variant?: 'auth' | 'home' | 'community';
  texture?: boolean;
  className?: string;
}): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const glows =
    variant === 'auth' ? AUTH_GLOWS : variant === 'community' ? COMMUNITY_GLOWS : HOME_GLOWS;

  return (
    <div
      aria-hidden="true"
      // overflow-hidden 保证光晕不会撑出横向滚动条(390px 下尤其重要)
      className={cn('pointer-events-none absolute inset-0 -z-10 overflow-hidden', className)}
      data-ambient={variant}
    >
      {texture ? (
        <div
          className={cn(
            'june-texture absolute inset-0',
            variant === 'community' ? 'opacity-100' : 'opacity-80',
          )}
        />
      ) : null}

      {glows.map((glow) => (
        <div
          key={glow.key}
          className={cn('june-glow', glow.className)}
          style={{
            background: glow.color,
            opacity: variant === 'community' ? 1 : undefined,
            animation: reducedMotion
              ? undefined
              : `june-breathe ${MOTION.durationAmbient}s var(--ease-in-out-june) ${glow.delaySeconds}s infinite`,
          }}
        />
      ))}
    </div>
  );
}
