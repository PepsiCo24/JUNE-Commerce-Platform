import { htmlToExcerpt, pageTitle, type PostDetail } from '@june/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { loadPostBySlug } from '@/features/community/load-post';
import { postDetailPath } from '@/features/community/utils';

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

/** 稳定公开短链。分享走这里，页面再跳到社区详情。 */
export default async function PublicPostShortLinkPage({ params }: PageProps): Promise<never> {
  const { slug } = await params;
  redirect(postDetailPath(slug));
}
