'use client';

import * as AvatarPrimitive from '@radix-ui/react-avatar';

import { avatarFallbackColor, cn, initialsOf } from '@/lib/utils';

/**
 * 头像。
 * 无 src 或图片加载失败时回退到"首字 + 稳定占位色",不出现破图。
 * 头像 URL 可能是短时签名 URL,过期后 Radix 会自动切到 fallback。
 */
/**
 * 占位色是 avatarFallbackColor 给出的固定品牌色板(明暗不一),
 * 因此首字颜色按相对亮度在"品牌墨色 / 象牙白"之间二选一,保证对比度达标。
 */
function inkOn(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.55 ? 'var(--color-indigo-950)' : 'var(--color-ivory-50)';
}

export function Avatar({
  src,
  name,
  size = 32,
  className,
}: {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
}): React.JSX.Element {
  const initials = initialsOf(name);
  const fallbackColor = avatarFallbackColor(name);

  return (
    <AvatarPrimitive.Root
      className={cn('relative inline-flex shrink-0 select-none overflow-hidden rounded-full', className)}
      // 尺寸是数值入参,只能走内联样式
      style={{ width: size, height: size }}
    >
      {src && (
        <AvatarPrimitive.Image src={src} alt={name} className="size-full object-cover" />
      )}
      <AvatarPrimitive.Fallback
        // 无头像时的占位色来自 avatarFallbackColor,同一用户恒定同色
        style={{
          backgroundColor: fallbackColor,
          color: inkOn(fallbackColor),
          fontSize: Math.max(10, Math.round(size * 0.4)),
        }}
        className="flex size-full items-center justify-center font-semibold"
        delayMs={src ? 300 : 0}
      >
        <span aria-hidden="true">{initials}</span>
        {/* 读屏读到的是完整用户名,而不是一个孤立的首字 */}
        <span className="sr-only">{name}</span>
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
