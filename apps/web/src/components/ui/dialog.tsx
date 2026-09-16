'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { motion } from 'motion/react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/providers/preferences-provider';

const SIZE_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[96vw]',
} as const;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 底部操作区 */
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  children?: React.ReactNode;
  /** 深色场景弹窗 */
  theme?: 'dark' | 'light';
}

/**
 * 模态对话框。焦点陷阱、ESC 关闭、点遮罩关闭、aria-modal 都由 Radix 提供。
 *
 * theme 默认 'dark':Portal 把内容挂到 <body> 下,不在页面的 data-theme 容器内,
 * 拿不到浅色场景(社区 / admin)的语义变量,所以浅色页面必须显式传 theme="light"。
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  size = 'md',
  children,
  theme = 'dark',
}: DialogProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const duration = reducedMotion ? 0 : 0.18;

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

        {/* 居中容器:pointer-events-none 让容器空白区域的点击穿透到 Overlay,由 Radix 判定关闭 */}
        <div
          data-theme={theme}
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <DialogPrimitive.Content
            asChild
            // 没有 description 时显式置空,避免 Radix 指向一个不存在的 id
            {...(description ? {} : { 'aria-describedby': undefined })}
          >
            <motion.div
              className={cn(
                'pointer-events-auto flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl border border-border-default bg-bg-elevated text-fg shadow-lg',
                SIZE_CLASS[size],
                size === 'full' && 'h-[92vh]',
              )}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration, ease: 'easeOut' }}
            >
              <div className="flex items-start justify-between gap-4 border-b border-border-default p-4 sm:p-5">
                <div className="min-w-0 space-y-1">
                  <DialogPrimitive.Title className="truncate text-base font-semibold text-fg">
                    {title}
                  </DialogPrimitive.Title>
                  {description && (
                    <DialogPrimitive.Description className="text-sm text-fg-muted">
                      {description}
                    </DialogPrimitive.Description>
                  )}
                </div>

                <DialogPrimitive.Close
                  aria-label="关闭"
                  className="-mr-1 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
                >
                  <X aria-hidden="true" className="size-4" />
                </DialogPrimitive.Close>
              </div>

              {children && <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{children}</div>}

              {footer && (
                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-default p-4 sm:px-5">
                  {footer}
                </div>
              )}
            </motion.div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
