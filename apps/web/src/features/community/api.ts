/**
 * 社区模块的接口调用与 query key。
 *
 * 路径、请求体、响应体全部以 `apps/api/src/modules/community/*.controller.ts` 为准:
 *   posts.controller.ts     GET  /community/posts            列表(页码分页)
 *                           GET  /community/my/posts         我的内容(含草稿与被隐藏)
 *                           GET  /community/posts/:slug      详情
 *                           POST /community/posts            发布新帖
 *                           PATCH /community/posts/:id       编辑已发布
 *                           DELETE /community/posts/:id      软删除
 *   comments.controller.ts  GET/POST /community/posts/:postId/comments、DELETE /community/comments/:id
 *   likes.controller.ts     POST/DELETE /community/posts/:id/like
 *   bookmarks.controller.ts GET /community/bookmarks、POST/DELETE /community/posts/:id/bookmark
 *   user-search.controller  GET /community/users/search
 *   drafts.controller.ts    POST/GET/PUT/DELETE /community/drafts[/:id]、POST /community/drafts/:id/publish
 *   share.controller.ts     GET  /community/posts/:slug/share
 *
 * 写操作一律走浏览器侧 `api`(自动带 CSRF 头);服务端组件取数用 `serverGet`,不在这里。
 */
import {
  PAGE_SIZE_DEFAULT,
  type AssetView,
  type CommentCreateInput,
  type CommentItem,
  type CommunityUserSummary,
  type CursorResult,
  type PageResult,
  type PostDetail,
  type PostDraftDetail,
  type PostDraftSaveInput,
  type PostListItem,
  type PostPublishInput,
  type PostCategory,
  type PostSort,
  type ShareResponse,
  type UploadTicketRequest,
  type UploadTicketResponse,
} from '@june/shared';

import { api } from '@/lib/api/client';

/** likes.service.ts 的 LikeResult(未导出到 @june/shared,这里按控制器返回值声明) */
export interface LikeResult {
  liked: boolean;
  likeCount: number;
}

/** bookmarks.service.ts 的 BookmarkResult(同上) */
export interface BookmarkResult {
  bookmarked: boolean;
}

/** drafts.service.ts 的 PostDraftSummary(同上) */
export interface PostDraftSummary {
  id: string;
  title: string;
  revision: number;
  coverAssetId: string | null;
  imageCount: number;
  updatedAt: string;
}

export type MyPostStatus = 'ALL' | 'DRAFT' | 'PUBLISHED' | 'HIDDEN';

export interface PostListParams {
  sort: PostSort;
  q?: string;
  category?: PostCategory;
  mine?: boolean;
}

/**
 * Query key 规范:第一段固定为 `community`。
 * 列表 key 里带上全部筛选条件,这样搜索词/排序一变就是另一份缓存,不会串数据。
 */
export const communityKeys = {
  all: ['community'] as const,
  posts: (params: PostListParams & { page?: number }) => ['community', 'posts', params] as const,
  postsFeed: (params: PostListParams & { pageSize?: number }) =>
    ['community', 'posts-feed', params] as const,
  post: (slug: string) => ['community', 'post', slug] as const,
  myPosts: (params: { status: MyPostStatus; q?: string; page?: number }) =>
    ['community', 'my-posts', params] as const,
  bookmarks: (params: { q?: string; page?: number } = {}) => ['community', 'bookmarks', params] as const,
  users: (params: { q: string }) => ['community', 'users', params] as const,
  userProfile: (id: string) => ['community', 'user-profile', id] as const,
  userPosts: (id: string, page?: number) => ['community', 'user-posts', id, page] as const,
  comments: (postId: string) => ['community', 'comments', postId] as const,
  draft: (draftId: string) => ['community', 'draft', draftId] as const,
  share: (slug: string) => ['community', 'share', slug] as const,
};

// ---------------------------------------------------------------------------
// 帖子
// ---------------------------------------------------------------------------

export function fetchPosts(
  params: PostListParams & { page?: number; pageSize?: number },
  signal?: AbortSignal,
): Promise<PageResult<PostListItem>> {
  return api.get<PageResult<PostListItem>>('/community/posts', {
    query: {
      sort: params.sort,
      q: params.q,
      category: params.category,
      mine: params.mine ? 'true' : undefined,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? PAGE_SIZE_DEFAULT,
    },
    signal,
  });
}

export function fetchMyPosts(
  params: { status: MyPostStatus; q?: string; page?: number; pageSize?: number },
  signal?: AbortSignal,
): Promise<PageResult<PostListItem>> {
  return api.get<PageResult<PostListItem>>('/community/my/posts', {
    query: {
      status: params.status,
      q: params.q,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? PAGE_SIZE_DEFAULT,
    },
    signal,
  });
}

export function fetchPostDetail(slug: string, signal?: AbortSignal): Promise<PostDetail> {
  return api.get<PostDetail>(`/community/posts/${encodeURIComponent(slug)}`, { signal });
}

export function publishNewPost(input: PostPublishInput): Promise<PostDetail> {
  return api.post<PostDetail>('/community/posts', input);
}

export function updatePost(postId: string, input: PostPublishInput): Promise<PostDetail> {
  return api.patch<PostDetail>(`/community/posts/${postId}`, input);
}

export function deletePost(postId: string): Promise<void> {
  return api.delete<void>(`/community/posts/${postId}`);
}

// ---------------------------------------------------------------------------
// 点赞
// ---------------------------------------------------------------------------

export function likePost(postId: string): Promise<LikeResult> {
  return api.post<LikeResult>(`/community/posts/${postId}/like`);
}

export function unlikePost(postId: string): Promise<LikeResult> {
  return api.delete<LikeResult>(`/community/posts/${postId}/like`);
}

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

export function bookmarkPost(postId: string): Promise<BookmarkResult> {
  return api.post<BookmarkResult>(`/community/posts/${postId}/bookmark`);
}

export function unbookmarkPost(postId: string): Promise<BookmarkResult> {
  return api.delete<BookmarkResult>(`/community/posts/${postId}/bookmark`);
}

export function fetchBookmarks(
  params: { q?: string; page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<PageResult<PostListItem>> {
  return api.get<PageResult<PostListItem>>('/community/bookmarks', {
    query: {
      q: params.q,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? PAGE_SIZE_DEFAULT,
    },
    signal,
  });
}

// ---------------------------------------------------------------------------
// 用户搜索
// ---------------------------------------------------------------------------

export function fetchUserSearch(
  params: { q: string; cursor?: string; limit?: number },
  signal?: AbortSignal,
): Promise<CursorResult<CommunityUserSummary>> {
  return api.get<CursorResult<CommunityUserSummary>>('/community/users/search', {
    query: {
      q: params.q,
      cursor: params.cursor,
      limit: params.limit ?? PAGE_SIZE_DEFAULT,
    },
    signal,
  });
}

// ---------------------------------------------------------------------------
// 评论
// ---------------------------------------------------------------------------

export function fetchComments(
  postId: string,
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<CursorResult<CommentItem>> {
  return api.get<CursorResult<CommentItem>>(`/community/posts/${postId}/comments`, {
    query: { cursor: params.cursor, limit: params.limit ?? PAGE_SIZE_DEFAULT },
    signal,
  });
}

export function createComment(postId: string, input: CommentCreateInput): Promise<CommentItem> {
  return api.post<CommentItem>(`/community/posts/${postId}/comments`, input);
}

export function deleteComment(commentId: string): Promise<void> {
  return api.delete<void>(`/community/comments/${commentId}`);
}

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

export function createDraft(): Promise<PostDraftDetail> {
  return api.post<PostDraftDetail>('/community/drafts');
}

export function fetchDraft(draftId: string, signal?: AbortSignal): Promise<PostDraftDetail> {
  return api.get<PostDraftDetail>(`/community/drafts/${draftId}`, { signal });
}

export function fetchDrafts(
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<CursorResult<PostDraftSummary>> {
  return api.get<CursorResult<PostDraftSummary>>('/community/drafts', {
    query: { cursor: params.cursor, limit: params.limit ?? PAGE_SIZE_DEFAULT },
    signal,
  });
}

/**
 * 草稿自动保存。
 * `signal` 用来取消上一次尚未完成的保存;`revision` 是乐观锁,服务端只接受更大的版本号。
 */
export function saveDraft(
  draftId: string,
  input: PostDraftSaveInput,
  signal?: AbortSignal,
): Promise<PostDraftDetail> {
  return api.put<PostDraftDetail>(`/community/drafts/${draftId}`, input, { signal });
}

export function publishDraft(draftId: string): Promise<PostDetail> {
  return api.post<PostDetail>(`/community/drafts/${draftId}/publish`);
}

export function deleteDraft(draftId: string): Promise<void> {
  return api.delete<void>(`/community/drafts/${draftId}`);
}

// ---------------------------------------------------------------------------
// 分享
// ---------------------------------------------------------------------------

export function fetchShare(slug: string, signal?: AbortSignal): Promise<ShareResponse> {
  return api.get<ShareResponse>(`/community/posts/${encodeURIComponent(slug)}/share`, { signal });
}

// ---------------------------------------------------------------------------
// 图片上传(签发凭证 → 直传 → confirm)
// ---------------------------------------------------------------------------

export function createUploadTicket(input: UploadTicketRequest): Promise<UploadTicketResponse> {
  return api.post<UploadTicketResponse>('/assets/upload-ticket', input);
}

export function confirmUpload(assetId: string): Promise<AssetView> {
  return api.post<AssetView>(`/assets/${assetId}/confirm`);
}
