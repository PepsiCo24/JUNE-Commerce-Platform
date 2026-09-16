'use client';

import { cloneElement, forwardRef, useCallback, useEffect, useId, useRef } from 'react';

import { cn } from '@/lib/utils';

const CONTROL_BASE =
  'w-full rounded-md border bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50';

function controlClass(invalid: boolean | undefined, className: string | undefined): string {
  return cn(
    CONTROL_BASE,
    invalid ? 'border-state-danger-border' : 'border-border-default hover:border-border-strong',
    className,
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ invalid, className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        // 外部通过 Field 传进来的 aria-invalid 会覆盖这里,两种用法都成立
        aria-invalid={invalid || undefined}
        className={controlClass(invalid, cn('h-10', className))}
        {...rest}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; autoGrow?: boolean }
>(function Textarea({ invalid, autoGrow = false, className, onInput, rows = 4, value, ...rest }, ref) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  // 同时满足"外部拿 ref"(表单库)与"内部量高度"(autoGrow)
  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const resize = useCallback(() => {
    const node = innerRef.current;
    if (!node || !autoGrow) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [autoGrow]);

  // 受控写入(如草稿回填)时也要重算高度
  useEffect(() => {
    resize();
  }, [resize, value]);

  return (
    <textarea
      ref={setRefs}
      rows={rows}
      value={value}
      aria-invalid={invalid || undefined}
      onInput={(event) => {
        resize();
        onInput?.(event);
      }}
      className={controlClass(invalid, cn('resize-y py-2 leading-relaxed', autoGrow && 'resize-none', className))}
      {...rest}
    />
  );
});

export function Label({
  htmlFor,
  required,
  children,
  className,
}: {
  htmlFor?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <label htmlFor={htmlFor} className={cn('inline-flex items-center gap-1 text-sm font-medium text-fg', className)}>
      {children}
      {required && (
        <>
          <span aria-hidden="true" className="text-state-danger-fg">
            *
          </span>
          <span className="sr-only">必填</span>
        </>
      )}
    </label>
  );
}

/** 表单字段容器:标签 + 控件 + 描述 + 错误。error 存在时自动给控件加 aria-invalid */
export function Field({
  label,
  htmlFor,
  required,
  description,
  error,
  addon,
  className,
  children,
}: {
  label?: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  description?: React.ReactNode;
  error?: string | null;
  /** 右上角额外内容,如字数统计 */
  addon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const generatedId = useId();
  const controlId = htmlFor ?? `field-${generatedId}`;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;

  const describedBy = [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ');

  // 把无障碍属性注入到唯一的控件子元素上:调用方不需要重复手写 aria-*
  const control = injectControlProps(children, {
    id: controlId,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
    'aria-required': required || undefined,
  });

  return (
    <div className={cn('space-y-1.5', className)}>
      {(label || addon) && (
        <div className="flex items-baseline justify-between gap-2">
          {label ? (
            <Label htmlFor={controlId} required={required}>
              {label}
            </Label>
          ) : (
            <span />
          )}
          {addon}
        </div>
      )}

      {control}

      {description && (
        <p id={descriptionId} className="text-xs text-fg-muted">
          {description}
        </p>
      )}

      {/* role="alert" 让校验失败即时播报,而不是等用户再次聚焦 */}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-state-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}

type InjectedProps = Record<string, unknown>;

function injectControlProps(children: React.ReactNode, props: InjectedProps): React.ReactNode {
  // 多个子元素时无法判断该给谁加 aria-*,原样渲染,交由调用方自行处理
  if (!isElement(children)) return children;

  const existing = children.props;
  return cloneElement(children, {
    ...props,
    // 调用方显式写了 id / aria-describedby 时优先保留
    id: (existing['id'] as string | undefined) ?? props['id'],
    'aria-describedby': mergeIds(existing['aria-describedby'], props['aria-describedby']),
  });
}

function isElement(node: React.ReactNode): node is React.ReactElement<InjectedProps> {
  return typeof node === 'object' && node !== null && 'type' in node;
}

function mergeIds(a: unknown, b: unknown): string | undefined {
  const parts = [a, b].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return parts.length ? parts.join(' ') : undefined;
}

/** 带上限提示的字数统计,超限显示危险色 */
export function CharCounter({ value, max }: { value: string; max: number }): React.JSX.Element {
  const length = [...value].length;
  const over = length > max;
  return (
    <span
      className={cn('tabular text-xs', over ? 'text-state-danger-fg' : 'text-fg-subtle')}
      // 超限才播报,避免每敲一个字都读一次
      aria-live={over ? 'polite' : 'off'}
    >
      {length} / {max}
    </span>
  );
}
