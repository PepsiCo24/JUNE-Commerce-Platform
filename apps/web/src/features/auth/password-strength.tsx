'use client';

import { PASSWORD_MIN_LENGTH } from '@june/shared';
import { Check, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 密码强度提示。
 *
 * 规则与 `@june/shared` 的 `passwordSchema` 完全一致,不额外发明标准:
 *   · 长度 ≥ PASSWORD_MIN_LENGTH
 *   · 小写 / 大写 / 数字 / 符号 四类字符中至少命中三类
 * 这里只是把同一条规则可视化,最终判定仍以后端为准。
 */

const CHARACTER_CLASSES = [
  { key: 'lower', test: /[a-z]/, label: '小写字母' },
  { key: 'upper', test: /[A-Z]/, label: '大写字母' },
  { key: 'digit', test: /\d/, label: '数字' },
  { key: 'symbol', test: /[^A-Za-z0-9]/, label: '符号' },
] as const;

/** 至少命中的字符类别数,与 passwordSchema 的 refine 一致 */
const REQUIRED_CLASSES = 3;

export interface PasswordStrength {
  /** 0~4:两条硬性规则 + 长度和类别的额外加分 */
  score: number;
  label: string;
  lengthOk: boolean;
  classesHit: number;
  classesOk: number;
  /** 是否已满足 passwordSchema 的全部要求 */
  valid: boolean;
}

export function evaluatePassword(password: string): PasswordStrength {
  const lengthOk = password.length >= PASSWORD_MIN_LENGTH;
  const classesHit = CHARACTER_CLASSES.filter((item) => item.test.test(password)).length;
  const classesOk = REQUIRED_CLASSES;
  const valid = lengthOk && classesHit >= REQUIRED_CLASSES;

  let score = 0;
  if (password.length > 0) score = 1;
  if (lengthOk) score += 1;
  if (classesHit >= REQUIRED_CLASSES) score += 1;
  // 更长 + 四类齐全才算"强",避免刚好达标就给满格的误导
  if (valid && password.length >= PASSWORD_MIN_LENGTH + 4 && classesHit === CHARACTER_CLASSES.length) score += 1;

  const label = !password ? '未填写' : score <= 1 ? '弱' : score === 2 ? '一般' : score === 3 ? '良好' : '强';

  return { score, label, lengthOk, classesHit, classesOk, valid };
}

export function PasswordStrengthMeter({
  password,
  className,
  id,
}: {
  password: string;
  className?: string;
  id?: string;
}): React.JSX.Element {
  const strength = evaluatePassword(password);

  return (
    <div id={id} className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        {/* 四格进度条:只用宽度与颜色表达强度,不做动画 */}
        <div className="flex h-1.5 flex-1 gap-1" aria-hidden="true">
          {[1, 2, 3, 4].map((step) => (
            <span
              key={step}
              className={cn(
                'h-full flex-1 rounded-full transition-colors',
                strength.score >= step
                  ? strength.valid
                    ? 'bg-accent'
                    : 'bg-state-warning-fg'
                  : 'bg-surface-active',
              )}
            />
          ))}
        </div>
        <span className={cn('text-xs', strength.valid ? 'text-accent' : 'text-fg-muted')}>
          强度:{strength.label}
        </span>
      </div>

      {/* 用 role="status" 播报规则达成情况,屏幕阅读器用户也能知道还差什么 */}
      <ul role="status" className="space-y-1 text-xs">
        <Rule ok={strength.lengthOk} text={`至少 ${PASSWORD_MIN_LENGTH} 位`} />
        <Rule
          ok={strength.classesHit >= strength.classesOk}
          text={`小写、大写、数字、符号中至少 ${strength.classesOk} 类(已满足 ${strength.classesHit} 类)`}
        />
      </ul>
    </div>
  );
}

function Rule({ ok, text }: { ok: boolean; text: string }): React.JSX.Element {
  return (
    <li className={cn('flex items-center gap-1.5', ok ? 'text-state-success-fg' : 'text-fg-muted')}>
      {ok ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
      <span>{text}</span>
    </li>
  );
}
