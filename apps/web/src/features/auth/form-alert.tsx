import { AlertCircle, CheckCircle2 } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 表单级提示条(整表错误 / 成功)。
 * UI 基础库没有提供 Alert,按契约约定放在本模块自己的目录下。
 */
export function FormAlert({
  tone = 'danger',
  children,
  className,
}: {
  tone?: 'danger' | 'success';
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const Icon = tone === 'danger' ? AlertCircle : CheckCircle2;

  return (
    <div
      // 错误用 alert 让屏幕阅读器立即播报,成功用 status 不打断当前朗读
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
        tone === 'danger'
          ? 'border-state-danger-border bg-state-danger-bg text-state-danger-fg'
          : 'border-state-success-border bg-state-success-bg text-state-success-fg',
        className,
      )}
    >
      <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}
