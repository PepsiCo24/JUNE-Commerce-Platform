'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** 需要用户逐字输入该文本才能确认,用于禁用用户、删除模型、清理存储等高危操作 */
  requireText?: string;
}

/**
 * 命令式二次确认。
 *
 * UI 基础库的 `useConfirm()` 依赖一个全局挂载点,管理站自己的页面不保证那个挂载点
 * 存在(它由另一个模块负责挂载),所以这里用局部渲染的 `ConfirmDialog` 提供同样的
 * 命令式体验:页面把 `confirmNode` 渲染一次,任何地方 `await confirm({...})` 即可。
 *
 * 之所以要命令式:危险操作通常写在 mutation 的调用点上,声明式弹窗会把"点按钮"和
 * "真正执行"拆到两个回调里,容易漏掉某个分支的确认。
 */
export function useActionConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmNode: ReactNode;
} {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    // 上一次还没结算就被新的确认覆盖时,按"取消"处理,避免调用方永远挂着
    resolverRef.current?.(false);
    setOptions(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const confirmNode = options ? (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
      title={options.title}
      description={options.description}
      confirmLabel={options.confirmLabel}
      danger={options.danger}
      requireText={options.requireText}
      theme="light"
      onConfirm={() => settle(true)}
    />
  ) : null;

  return { confirm, confirmNode };
}
