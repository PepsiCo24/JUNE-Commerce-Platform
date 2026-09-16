'use client';

import { useSearchParams } from 'next/navigation';

import { DraftEditorLoader } from '@/features/community/editor/editor-loaders';
import { PostEditor } from '@/features/community/editor/post-editor';

export function NewPostClient(): React.JSX.Element {
  const searchParams = useSearchParams();
  const draftId = searchParams.get('draftId')?.trim() ?? '';

  if (draftId) return <DraftEditorLoader draftId={draftId} />;
  return <PostEditor mode="create" />;
}
