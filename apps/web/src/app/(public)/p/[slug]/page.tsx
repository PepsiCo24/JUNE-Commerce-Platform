import { htmlToExcerpt, pageTitle, type PostDetail } from '@june/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { postDetailPath } from '@/features/community/utils';
import { serverGetCaught } from '@/lib/api/server';

type PageProps = { params: Promise<{ slug: string }> };

async function loadPost(slug: string) {
  return serverGetCaught<PostDetail>(`/community/posts/${encodeURIComponent(slug)}`);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await loadPost(slug);
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
