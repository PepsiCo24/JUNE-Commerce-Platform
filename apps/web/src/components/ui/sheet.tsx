'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { motion } from 'motion/react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/providers/preferences-provider';

const SIDE_CLASS = {
  left: 'inset-y-0 left-0 h-full w-[85vw] max-w-sm border-r',
  right: 'inset-y-0 right-0 h-full w-[85vw] max-w-sm border-l',
  bottom: 'inset-x-0 bottom-0 max-h-[85vh] w-full border-t',
} as const;

/** 各方向的入场位移(只动 transform) */
const SIDE_OFFSET = {
  left: { x: '-100%', y: 0 },
  right: { x: '100%', y: 0 },
  bottom: { x: 0, y: '100%' },
} as const;

/**
 * 移动端抽屉。用于折叠导航等场景;焦点陷阱与 ESC 关闭由 Radix Dialog 提供。
 * theme 默认 'dark',原因同 Dialog:Portal 内容不在页面 data-theme 容器内。
 */
export function Sheet({
  open,
  onOpenChange,
  side = 'right',
  title,
  children,
  theme = 'dark',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: 'left' | 'right' | 'bottom';
  title: React.ReactNode;
  children: React.ReactNode;
  theme?: 'dark' | 'light';
}): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const duration = reducedMotion ? 0 : 0.22;
  const offset = SIDE_OFFSET[side];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay asChild>
          <motion.div
            data-theme={theme}
            className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration }}
          />
        </DialogPrimitive.Overlay>

        <DialogPrimitive.Content asChild aria-describedby={undefined}>
          <motion.div
            data-theme={theme}
            className={cn(
              'fixed z-50 flex flex-col border-border-default bg-bg-elevated text-fg shadow-lg',
              SIDE_CLASS[side],
              side === 'bottom' && 'rounded-t-xl',
            )}
            initial={{ ...offset, opacity: reducedMotion ? 1 : 0.6 }}
            animate={{ x: 0, y: 0, opacity: 1 }}
            transition={{ duration, ease: 'easeOut' }}
          >
            <div className="flex items-center justify-between gap-4 border-b border-border-default p-4">
              <DialogPrimitive.Title className="truncate text-base font-semibold text-fg">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close
                aria-label="关闭"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
              >
                <X aria-hidden="true" className="size-4" />
              </DialogPrimitive.Close>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
