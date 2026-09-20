import { ERROR_CODES, htmlToExcerpt, pageTitle, type PostDetail } from '@june/shared';
import type { Metadata } from 'next';

import { loadPostBySlug } from '@/features/community/load-post';
import { PostDetailView } from '@/features/community/posts/post-detail-view';
import { PostNotice } from '@/features/community/posts/post-notice';
import { ApiError, NetworkError } from '@/lib/api/errors';

/**
 * 公开帖子详情。
 *
 * 必须用 `serverGetCaught`：失败时保留 POST_HIDDEN / POST_NOT_PUBLISHED / NOT_FOUND，
 * `serverGetOptional` 会丢掉错误码，无法渲染对应提示。
 */

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await loadPostBySlug(slug);
  if (!result.ok) {
    return { title: pageTitle('帖子') };
  }

  const post = result.data;
  const description = post.excerpt ?? htmlToExcerpt(post.contentHtml);
  return {
    title: pageTitle(post.title),
    description,
    openGraph: {
      title: post.title,
      description,
      type: 'article',
      url: post.shareUrl ?? undefined,
      images: post.coverUrl ? [{ url: post.coverUrl }] : undefined,
    },
  };
}

export default async function CommunityPostDetailPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const result = await loadPostBySlug(slug);

  if (!result.ok) {
    const code = result.error instanceof ApiError ? result.error.code : ERROR_CODES.INTERNAL_ERROR;
    const retryable = result.error instanceof NetworkError || (result.error instanceof ApiError && result.error.isRetryable);
    return (
      <div className="mx-auto w-full max-w-[90rem] px-4 py-8 sm:px-6">
        <PostNotice code={code} slug={slug} retryable={retryable} />
      </div>
    );
  }

  return <PostDetailView post={result.data} />;
}
