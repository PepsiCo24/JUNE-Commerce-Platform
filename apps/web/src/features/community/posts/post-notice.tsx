'use client';

import { ERROR_CODES } from '@june/shared';
import { EyeOff, FileClock, Lock, RefreshCw, SearchX } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

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
  slug,
  retryable = false,
}: {
  code: string;
  backHref?: string;
  backLabel?: string;
  /** 用于刷新重试 */
  slug?: string;
  retryable?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const preset = describeNotice(code);

  return (
    <div className="mx-auto w-full max-w-2xl py-16">
      <EmptyState
        icon={preset.icon}
        title={preset.title}
        description={preset.description}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {retryable && slug ? (
              <Button
                variant="primary"
                iconLeft={<RefreshCw size={16} />}
                onClick={() => router.refresh()}
              >
                重试
              </Button>
            ) : null}
            <Button variant="secondary" asChild>
              <Link href={backHref}>{backLabel}</Link>
            </Button>
          </div>
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
    case ERROR_CODES.NOT_FOUND:
      return {
        icon: <SearchX size={28} />,
        title: '找不到这篇内容',
        description: '链接可能已失效,或内容已被删除。请返回大厅查看最新列表。',
      };
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
    case ERROR_CODES.INTERNAL_ERROR:
      return {
        icon: <RefreshCw size={28} />,
        title: '暂时无法加载内容',
        description: '服务连接异常,请稍后重试。若持续出现,请联系管理员检查服务端 API 配置。',
      };
    default:
      return {
        icon: <EyeOff size={28} />,
        title: '暂时无法查看这篇内容',
        description: '内容可能已被调整或暂不可访问,请稍后再试。',
      };
  }
}
