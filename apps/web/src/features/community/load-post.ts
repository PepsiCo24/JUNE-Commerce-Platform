import { cache } from 'react';

import type { PostDetail } from '@june/shared';

import { serverGetCaught } from '@/lib/api/server';

import { normalizePostSlug } from './utils';

/** 同一请求内 metadata 与 page 共享,避免重复取数且 slug 口径一致 */
export const loadPostBySlug = cache(async (rawSlug: string) => {
  const slug = normalizePostSlug(rawSlug);
  return serverGetCaught<PostDetail>(`/community/posts/${encodeURIComponent(slug)}`);
});
