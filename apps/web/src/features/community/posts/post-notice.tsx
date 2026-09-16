import { ERROR_CODES } from '@june/shared';
import { EyeOff, FileClock, Lock } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';

/**
 * 不可访问内容的提示页。
 *
 * 这些分支只在**服务端取数拿到错误码**时渲染,
 * 也就是说可见性是每次请求由后端重新判定的,前端不会因为"之前拿到过数据"而继续展示内容。
 * 提示文案不泄漏标题、摘要与正文。
 */
export function PostNotice({
  code,
  backHref = '/community',
  backLabel = '返回帖子大厅',
}: {
  code: string;
  backHref?: string;
  backLabel?: string;
}): React.JSX.Element {
  const preset = describeNotice(code);

  return (
    <div className="mx-auto w-full max-w-2xl py-16">
      <EmptyState
        icon={preset.icon}
        title={preset.title}
        description={preset.description}
        action={
          <Button variant="secondary" asChild>
            <Link href={backHref}>{backLabel}</Link>
          </Button>
        }
      />
    </div>
  );
}

function describeNotice(code: string): {
  icon: React.ReactNode;
  title: string;
  description: string;
} {
  switch (code) {
    case ERROR_CODES.POST_NOT_PUBLISHED:
      return {
        icon: <FileClock size={28} />,
        title: '该内容尚未发布',
        description: '作者还在编辑这篇内容,发布之后才能通过链接访问。',
      };
    case ERROR_CODES.POST_HIDDEN:
      return {
        icon: <EyeOff size={28} />,
        title: '该内容已被管理员隐藏',
        description: '如果你是作者,可以在「我的内容 · 已隐藏」里查看;有疑问请联系管理员。',
      };
    case ERROR_CODES.UNAUTHENTICATED:
    case ERROR_CODES.SESSION_EXPIRED:
      return {
        icon: <Lock size={28} />,
        title: '请先登录',
        description: '登录后才能查看这篇内容。',
      };
    default:
      return {
        icon: <EyeOff size={28} />,
        title: '暂时无法查看这篇内容',
        description: '内容可能已被调整或暂不可访问,请稍后再试。',
      };
  }
}
