'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useId, useState } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * 带显示/隐藏切换的密码输入框。
 * 切换的是 input 的 type,不做任何明文缓存;默认隐藏。
 */
export function PasswordInput({
  id,
  name,
  value,
  onChange,
  invalid,
  autoComplete,
  placeholder,
  disabled,
  className,
  describedBy,
}: {
  id?: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  autoComplete?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  describedBy?: string;
}): React.JSX.Element {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [visible, setVisible] = useState(false);

  return (
    <div className={cn('relative', className)}>
      <Input
        id={inputId}
        name={name}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        invalid={invalid}
        autoComplete={autoComplete}
        placeholder={placeholder}
        disabled={disabled}
        aria-describedby={describedBy}
        // 给右侧的切换按钮留出位置,文字不会被盖住
        className="pr-11"
      />
      <button
        type="button"
        onClick={() => setVisible((prev) => !prev)}
        disabled={disabled}
        aria-label={visible ? '隐藏密码' : '显示密码'}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-fg-subtle transition-colors hover:text-fg disabled:cursor-not-allowed"
      >
        {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}
