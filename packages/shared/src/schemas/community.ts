import { z } from 'zod';

import {
  COMMENT_MAX,
  COMMUNITY_SEARCH_TYPES,
  POST_CONTENT_MAX_BYTES,
  POST_EXCERPT_MAX,
  POST_MAX_IMAGES,
  POST_SORT_OPTIONS,
  POST_TITLE_MAX,
} from '../constants';
import { cursorQuerySchema, idSchema } from './common';

// ---------------------------------------------------------------------------
// 帖子
// ---------------------------------------------------------------------------

export const postTitleSchema = z.string().trim().min(2, '标题至少 2 个字符').max(POST_TITLE_MAX);

/**
 * 富文本正文。前端提交 HTML + 编辑器 JSON,服务端对 HTML 做白名单清洗后落库,
 * 渲染只使用清洗后的结果。这里只做长度与基本形态校验。
 */
export const postContentHtmlSchema = z
  .string()
  .max(POST_CONTENT_MAX_BYTES, '正文内容过长')
  .refine((v) => v.trim().length > 0, { message: '正文不能为空' });

export const postDraftSaveSchema = z.object({
  title: z.string().trim().max(POST_TITLE_MAX).default(''),
  contentHtml: z.string().max(POST_CONTENT_MAX_BYTES).default(''),
  contentJson: z.unknown().optional(),
  coverAssetId: idSchema.nullable().optional(),
  imageAssetIds: z.array(idSchema).max(POST_MAX_IMAGES).default([]),
  /**
   * 客户端持有的草稿版本号。服务端仅在 revision >= 当前值时接受写入,
   * 从而防止乱序到达的旧自动保存请求覆盖新内容。
   */
  revision: z.number().int().min(0),
});
export type PostDraftSaveInput = z.infer<typeof postDraftSaveSchema>;

export const postPublishSchema = z.object({
  title: postTitleSchema,
  contentHtml: postContentHtmlSchema,
  contentJson: z.unknown().optional(),
  excerpt: z.string().trim().max(POST_EXCERPT_MAX).optional(),
  coverAssetId: idSchema.nullable().optional(),
  imageAssetIds: z.array(idSchema).max(POST_MAX_IMAGES).default([]),
});
export type PostPublishInput = z.infer<typeof postPublishSchema>;

export const postListQuerySchema = cursorQuerySchema.extend({
  sort: z.enum(POST_SORT_OPTIONS).default('latest'),
  q: z.string().trim().max(120).optional(),
  /** 只看自己的帖子(我的创作) */
  mine: z.coerce.boolean().default(false),
  /** 指定作者的公开帖子(个人主页) */
  authorId: idSchema.optional(),
});
export type PostListQuery = z.infer<typeof postListQuerySchema>;

export const myPostListQuerySchema = cursorQuerySchema.extend({
  status: z.enum(['ALL', 'DRAFT', 'PUBLISHED', 'HIDDEN']).default('ALL'),
  q: z.string().trim().max(120).optional(),
});

export const bookmarkListQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
});
export type BookmarkListQuery = z.infer<typeof bookmarkListQuerySchema>;

export const userSearchQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().min(1).max(120),
});
export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;

export const communitySearchTypeSchema = z.enum(COMMUNITY_SEARCH_TYPES).default('all');

export interface PostAuthorSummary {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CommunityUserSummary {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  /** 已发布公开帖子数 */
  publishedPostCount: number;
}

/** 公开个人主页(不含邮箱等私密字段) */
export interface PublicUserProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  location: string | null;
  website: string | null;
  joinedAt: string;
  stats: {
    publishedPostCount: number;
    totalLikeCount: number;
  };
}

export interface PostListItem {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  coverUrl: string | null;
  coverWidth: number | null;
  coverHeight: number | null;
  /** 正文/封面图片总数(列表只展示代表图) */
  imageCount: number;
  author: PostAuthorSummary;
  publishedAt: string | null;
  likeCount: number;
  commentCount: number;
  isPinned: boolean;
  /** 当前用户是否已点赞 */
  likedByMe: boolean;
  /** 当前用户是否已收藏 */
  bookmarkedByMe: boolean;
  status: 'DRAFT' | 'PUBLISHED' | 'HIDDEN' | 'DELETED';
  updatedAt: string;
  /**
   * 收藏列表专用:帖子不可访问时为 true。
   * 此时 title/excerpt/cover 为空或占位,仍可取消收藏。
   */
  unavailable?: boolean;
  /** 收藏时间(仅「我的收藏」列表) */
  bookmarkedAt?: string;
}

export interface PostDetail extends PostListItem {
  contentHtml: string;
  images: Array<{ assetId: string; url: string; previewUrl: string; width: number | null; height: number | null }>;
  contentEditedAt: string | null;
  viewCount: number;
  canEdit: boolean;
  canDelete: boolean;
  /** 已发布帖子的稳定公开链接 */
  shareUrl: string | null;
}

export interface PostDraftDetail {
  id: string;
  title: string;
  contentHtml: string;
  contentJson: unknown;
  coverAssetId: string | null;
  imageAssetIds: string[];
  revision: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 评论
// ---------------------------------------------------------------------------

export const commentCreateSchema = z.object({
  content: z.string().trim().min(1, '评论内容不能为空').max(COMMENT_MAX),
  /** 回复目标评论 id */
  parentId: idSchema.nullable().optional(),
});
export type CommentCreateInput = z.infer<typeof commentCreateSchema>;

export const commentListQuerySchema = cursorQuerySchema;

export interface CommentItem {
  id: string;
  content: string;
  author: PostAuthorSummary;
  parentId: string | null;
  /** 被回复者昵称,便于前端展示"回复 @xxx" */
  replyToName: string | null;
  createdAt: string;
  canDelete: boolean;
  status: 'VISIBLE' | 'HIDDEN' | 'DELETED';
  replies?: CommentItem[];
}

// ---------------------------------------------------------------------------
// 分享
// ---------------------------------------------------------------------------

export const SHARE_CHANNELS = ['link', 'qrcode', 'wechat', 'qq'] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

/** 分享元信息,按具体帖子生成 */
export interface ShareMeta {
  url: string;
  title: string;
  description: string;
  imageUrl: string | null;
}

/** 各渠道可用性。不可用时必须给出原因并降级,不伪造分享成功。 */
export interface ShareCapabilities {
  link: { available: true };
  qrcode: { available: true };
  wechat:
    | { available: true; mode: 'jssdk'; signature: WechatJsSdkConfig }
    | { available: false; reason: string; fallback: 'qrcode' | 'link' };
  qq: { available: true; shareUrl: string } | { available: false; reason: string; fallback: 'qrcode' | 'link' };
}

/** 微信 JS-SDK 配置,签名在后端生成,appId 之外不下发任何密钥 */
export interface WechatJsSdkConfig {
  appId: string;
  timestamp: string;
  nonceStr: string;
  signature: string;
  jsApiList: string[];
}

export interface ShareResponse {
  meta: ShareMeta;
  capabilities: ShareCapabilities;
  /** 二维码 SVG(后端生成,避免前端依赖额外库) */
  qrcodeSvg: string;
}
