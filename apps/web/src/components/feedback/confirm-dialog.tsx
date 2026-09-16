'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  requireText?: string;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  theme?: 'dark' | 'light';
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  requireText,
  loading = false,
  onConfirm,
  theme = 'dark',
}: ConfirmDialogProps): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const blocked = Boolean(requireText) && typed !== requireText;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('');
        onOpenChange(next);
      }}
      title={title}
      description={description}
      theme={theme}
      size="sm"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={loading}
            disabled={blocked}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {requireText ? (
        <label className="block space-y-2 text-sm">
          <span className="text-fg-muted">
            请输入 <span className="font-medium text-fg">{requireText}</span> 以确认
          </span>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-label="确认文本"
            autoComplete="off"
          />
        </label>
      ) : null}
    </Dialog>
  );
}

type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  requireText?: string;
  theme?: 'dark' | 'light';
};

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    resolverRef.current?.(false);
    setOptions(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {options ? (
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
          theme={options.theme ?? 'dark'}
          onConfirm={() => settle(true)}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error('useConfirm 必须在 ConfirmProvider 内使用');
  return context;
}
