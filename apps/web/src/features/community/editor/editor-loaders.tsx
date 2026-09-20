'use client';

import type { AssetView, PostDetail } from '@june/shared';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { ErrorState, LoadingState } from '@/components/feedback/states';

import { communityKeys, confirmUpload, fetchDraft, fetchPostDetail } from '../api';
import { inferCoverAssetId, PostEditor, postImagesToAssets } from './post-editor';

/** 继续编辑已有草稿:先把草稿和图片资产拉齐,再交给编辑器。 */
export function DraftEditorLoader({ draftId }: { draftId: string }): React.JSX.Element {
  const query = useQuery({
    queryKey: communityKeys.draft(draftId),
    queryFn: ({ signal }) => fetchDraft(draftId, signal),
  });

  const imagesQuery = useQuery({
    queryKey: [...communityKeys.draft(draftId), 'images'],
    enabled: Boolean(query.data),
    queryFn: () => hydrateAssets(query.data?.imageAssetIds ?? []),
  });

  if (query.isPending || (query.data && imagesQuery.isPending)) {
    return <LoadingState message="正在打开草稿" />;
  }

  if (query.isError || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} title="草稿加载失败" />;
  }

  if (imagesQuery.isError) {
    return <ErrorState error={imagesQuery.error} onRetry={() => void imagesQuery.refetch()} title="草稿图片加载失败" />;
  }

  const draft = query.data;
  return (
    <PostEditor
      mode="create"
      initialDraftId={draft.id}
      initialRevision={draft.revision}
      initialTitle={draft.title}
      initialHtml={draft.contentHtml}
      initialJson={draft.contentJson}
      initialImages={imagesQuery.data ?? []}
      initialCoverAssetId={draft.coverAssetId}
      initialCategory={draft.category}
    />
  );
}

/** 编辑已发布帖子。草稿会被送回发布页,避免走 updatePost。 */
export function PublishedEditorLoader({ slug }: { slug: string }): React.JSX.Element {
  const router = useRouter();
  const query = useQuery({
    queryKey: communityKeys.post(slug),
    queryFn: ({ signal }) => fetchPostDetail(slug, signal),
  });

  useEffect(() => {
    if (query.data?.status === 'DRAFT') {
      router.replace(`/community/drafts/${encodeURIComponent(query.data.id)}`);
    }
  }, [query.data, router]);

  if (query.isPending) return <LoadingState message="正在打开编辑器" />;

  if (query.isError || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} title="帖子加载失败" />;
  }

  const post = query.data;
  if (post.status === 'DRAFT') {
    return <LoadingState message="正在打开草稿" />;
  }

  if (!post.canEdit) {
    return <ErrorState error={new Error('没有权限编辑这篇内容')} title="无法编辑" />;
  }

  const assets = postImagesToAssets(post);
  return (
    <PublishedEditor post={post} assets={assets} />
  );
}

function PublishedEditor({ post, assets }: { post: PostDetail; assets: AssetView[] }): React.JSX.Element {
  return (
    <PostEditor
      mode="edit"
      postId={post.id}
      slug={post.slug}
      initialTitle={post.title}
      initialHtml={post.contentHtml}
      initialImages={assets}
      initialCoverAssetId={inferCoverAssetId(post, assets)}
      initialCategory={post.category}
    />
  );
}

async function hydrateAssets(ids: string[]): Promise<AssetView[]> {
  const results: AssetView[] = [];
  for (const id of ids) {
    try {
      results.push(await confirmUpload(id));
    } catch {
      // 单张失败不影响其余图片,编辑器仍可打开
    }
  }
  return results;
}

