import { CircleHelp } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 徽标。
 *
 * 本文件不加 'use client':纯展示、无 hooks、无事件处理,能直接在 RSC 里渲染
 * (列表/表格里 StatusBadge 出现频率极高,放在服务端渲染可以省掉可观的客户端 JS)。
 * 因此 UNKNOWN 的说明用原生 title + sr-only 文本,而不是 Radix Tooltip(会引入客户端边界)。
 */

export type BadgeTone = 'neutral' | 'accent' | 'purple' | 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'border-border-default bg-surface text-fg-muted',
  accent: 'border-accent-border bg-accent-surface text-accent',
  purple: 'border-border-default bg-surface text-purple-accent',
  success: 'border-state-success-border bg-state-success-bg text-state-success-fg',
  warning: 'border-state-warning-border bg-state-warning-bg text-state-warning-fg',
  danger: 'border-state-danger-border bg-state-danger-bg text-state-danger-fg',
  info: 'border-state-info-border bg-state-info-bg text-state-info-fg',
};

const SIZE_CLASS = {
  sm: 'h-5 gap-1 px-1.5 text-[11px]',
  md: 'h-6 gap-1.5 px-2 text-xs',
} as const;

export function Badge({
  tone = 'neutral',
  size = 'md',
  icon,
  className,
  children,
}: {
  tone?: BadgeTone;
  size?: 'sm' | 'md';
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full border font-medium leading-none',
        SIZE_CLASS[size],
        TONE_CLASS[tone],
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

interface StatusMeta {
  tone: BadgeTone;
  label: string;
  /** 需要额外解释的状态(悬浮 title + 屏幕阅读器可读) */
  hint?: string;
}

/**
 * 状态枚举 → tone + 中文文案。
 * 覆盖后端全部状态枚举;新增枚举时兜底为 neutral + 原文,不会渲染成空白。
 */
const STATUS_MAP: Record<string, StatusMeta> = {
  // 中性:尚未生效 / 已终止但无异常
  DRAFT: { tone: 'neutral', label: '草稿' },
  PENDING: { tone: 'neutral', label: '待处理' },
  QUEUED: { tone: 'neutral', label: '排队中' },
  ARCHIVED: { tone: 'neutral', label: '已归档' },
  CANCELED: { tone: 'neutral', label: '已取消' },
  PURGED: { tone: 'neutral', label: '已清除' },

  // 强调:正常生效中
  PUBLISHED: { tone: 'accent', label: '已发布' },
  ACTIVE: { tone: 'accent', label: '启用中' },
  VISIBLE: { tone: 'accent', label: '显示中' },

  // 信息:进行中
  RUNNING: { tone: 'info', label: '处理中' },
  VALIDATING: { tone: 'info', label: '校验中' },

  // 成功
  SUCCEEDED: { tone: 'success', label: '已完成' },

  // 警告:需要关注但不是失败
  PARTIAL: { tone: 'warning', label: '部分成功' },
  HIDDEN: { tone: 'warning', label: '已隐藏' },
  PAUSED: { tone: 'warning', label: '已暂停' },
  OFF_SHELF: { tone: 'warning', label: '已下架' },
  UNKNOWN: {
    tone: 'warning',
    label: '结果待确认',
    // 上游结果未知时重复提交会重复计费,所以这里明确劝阻重试
    hint: '上游结果待确认,系统正在核对,请勿重复提交',
  },
  ORPHAN: { tone: 'warning', label: '无引用' },
  RECYCLED: { tone: 'warning', label: '回收期' },
  TIMEOUT: { tone: 'warning', label: '已超时' },

  // 危险:失败 / 被禁用
  FAILED: { tone: 'danger', label: '失败' },
  DELETED: { tone: 'danger', label: '已删除' },
  DISABLED: { tone: 'danger', label: '已禁用' },
  CLOSED: { tone: 'danger', label: '已关闭' },
};

/** 任务/帖子/商品状态徽标:内部把状态枚举映射到 tone 与中文文案 */
export function StatusBadge({ status, className }: { status: string; className?: string }): React.JSX.Element {
  const meta = STATUS_MAP[status] ?? { tone: 'neutral' as BadgeTone, label: status };

  const badge = (
    <Badge
      tone={meta.tone}
      className={className}
      icon={meta.hint ? <CircleHelp aria-hidden="true" className="size-3 shrink-0" /> : undefined}
    >
      {meta.label}
    </Badge>
  );

  if (!meta.hint) return badge;

  return (
    <span title={meta.hint} className="inline-flex max-w-full items-center">
      {badge}
      {/* 鼠标用户看 title,键盘/读屏用户读这段 */}
      <span className="sr-only">{meta.hint}</span>
    </span>
  );
}
